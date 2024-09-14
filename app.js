const express = require('express');
const bodyParser = require('body-parser');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');
const ejs = require('ejs');

// aws sdk v3 imports
const {
  CognitoIdentityProviderClient,
  SignUpCommand,
  InitiateAuthCommand,
} = require('@aws-sdk/client-cognito-identity-provider');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');

// pdf parsing and ocr modules
const pdfParse = require('pdf-parse');
const { fromPath } = require('pdf2pic');
const Tesseract = require('tesseract.js');

dotenv.config();

// initialize app
const app = express();
const port = 3000;

// aws config 
const REGION = process.env.REGION;
const USER_POOL_ID = process.env.USER_POOL_ID;
const CLIENT_ID = process.env.CLIENT_ID;
const BUCKET_NAME = process.env.BUCKET_NAME;
const LAMBDA_FUNCTION_NAME = process.env.LAMBDA_FUNCTION_NAME;

const cognitoClient = new CognitoIdentityProviderClient({ region: REGION });
const s3Client = new S3Client({ region: REGION });
const lambdaClient = new LambdaClient({ region: REGION });

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(
  session({
    secret: 'your-session-secret',
    resave: false,
    saveUninitialized: true,
  })
);

app.use((req, res, next) => {
  res.locals.session = req.session;
  next();
});

const storage = multer.diskStorage({
  destination: 'uploads/',
  filename: function (req, file, cb) {
    cb(null, Date.now() + '_' + file.originalname);
  },
});

const upload = multer({ storage: storage });

function isAuthenticated(req, res, next) {
  if (req.session.user) {
    next();
  } else {
    res.redirect('/login');
  }
}

//home
app.get('/', isAuthenticated, (req, res) => {
  res.redirect('/upload');
});

//registration
app.get('/register', (req, res) => {
  res.render('register', { error: null });
});

app.post('/register', async (req, res) => {
  const { email, password } = req.body;

  const params = {
    ClientId: CLIENT_ID,
    Username: email,
    Password: password,
  };

  try {
    await cognitoClient.send(new SignUpCommand(params));
    res.redirect('/login');
  } catch (err) {
    console.error(err);
    res.render('register', { error: err.message || JSON.stringify(err) });
  }
});

//login
app.get('/login', (req, res) => {
  res.render('login', { error: null });
});

app.post('/login', async (req, res) => {
  const { email, password } = req.body;

  const params = {
    AuthFlow: 'USER_PASSWORD_AUTH',
    ClientId: CLIENT_ID,
    AuthParameters: {
      USERNAME: email,
      PASSWORD: password,
    },
  };

  try {
    const authResult = await cognitoClient.send(new InitiateAuthCommand(params));
    req.session.user = email;
    res.redirect('/upload');
  } catch (err) {
    console.error(err);
    res.render('login', { error: err.message || JSON.stringify(err) });
  }
});

//logout
app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

//upload
app.get('/upload', isAuthenticated, (req, res) => {
  res.render('upload', { error: null });
});

app.post('/upload', isAuthenticated, upload.single('pdf'), async (req, res) => {
  const pdfPath = req.file.path;

  try {
    console.log('Starting PDF processing...');
    let pdfText = '';
    const dataBuffer = fs.readFileSync(pdfPath);

    const data = await pdfParse(dataBuffer);
    pdfText = data.text;

    console.log('Text extracted using pdf-parse:', pdfText.length, 'characters');

    if (!pdfText.trim()) {
      console.log('No text extracted with pdf-parse, using Tesseract for OCR...');
      const options = {
        density: 200,
        saveFilename: 'page',
        savePath: './uploads',
        format: 'png',
        width: 1200,
        height: 1600,
      };

      const storeAsImage = fromPath(pdfPath, options);
      const pageCount = await getPageCount(pdfPath);

      for (let page = 1; page <= pageCount; page++) {
        console.log(`Converting page ${page} to image...`);
        const imagePath = await storeAsImage(page);

        console.log(`Performing OCR on page ${page}...`);
        const { data: { text } } = await Tesseract.recognize(imagePath.path, 'eng', { logger: m => console.log(m) });
        pdfText += text + '\n';

        fs.unlinkSync(imagePath.path);
      }

      console.log('Text extracted using OCR:', pdfText.length, 'characters');
    }

    // upload text to s3
    const s3Params = {
      Bucket: BUCKET_NAME,
      Key: `pdf-texts/${req.session.user}/${req.file.filename}.txt`,
      Body: pdfText,
    };

    await s3Client.send(new PutObjectCommand(s3Params));
    console.log('Text uploaded to S3:', s3Params.Key);

    // store  S3 key in the session for later use
    req.session.pdfKey = s3Params.Key;

    // reset conversation
    req.session.conversation = [];

    fs.unlinkSync(pdfPath);

    res.redirect('/chat');
  } catch (error) {
    console.error('Error during PDF processing:', error);
    res.render('upload', { error: 'Error processing PDF.' });
  }
});

// chat
app.get('/chat', isAuthenticated, (req, res) => {
  res.render('chat', { error: null, conversation: req.session.conversation || [] });
});

app.post('/chat', isAuthenticated, async (req, res) => {
  const question = req.body.question;
  const pdfKey = req.session.pdfKey;

  if (!pdfKey) {
    res.render('chat', { error: 'No PDF uploaded.', conversation: req.session.conversation || [] });
    return;
  }

  try {
    // get text from s3
    const s3Params = {
      Bucket: BUCKET_NAME,
      Key: pdfKey,
    };

    const data = await s3Client.send(new GetObjectCommand(s3Params));
    const pdfText = await streamToString(data.Body);

    // lambda function
    const lambdaParams = {
      FunctionName: LAMBDA_FUNCTION_NAME,
      InvocationType: 'RequestResponse',
      Payload: JSON.stringify({
        question: question,
        pdfText: pdfText,
      }),
    };

    const lambdaData = await lambdaClient.send(new InvokeCommand(lambdaParams));
    const responsePayload = JSON.parse(Buffer.from(lambdaData.Payload).toString());
    const answer = responsePayload.answer;

    // store conversation in session
    if (!req.session.conversation) {
      req.session.conversation = [];
    }

    req.session.conversation.push({
      question: question,
      answer: answer,
    });

    res.redirect('/chat');
  } catch (err) {
    console.error('Error during chat processing:', err);
    res.render('chat', { error: 'Error processing your request.', conversation: req.session.conversation || [] });
  }
});

// upload new document
app.post('/new-document', isAuthenticated, (req, res) => {
  req.session.conversation = [];
  req.session.pdfKey = null;
  res.redirect('/upload');
});

async function getPageCount(pdfPath) {
  const dataBuffer = fs.readFileSync(pdfPath);
  const data = await pdfParse(dataBuffer);
  return data.numpages;
}

function streamToString(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on('error', (err) => reject(err));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
