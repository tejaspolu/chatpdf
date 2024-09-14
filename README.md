# chatpdf
**chatpdf** is a serverless application that allows users to upload pdfs and ask questions about the document

## features
- upload pdfs and extract text
- store pdf text in amazon s3
- ask questions about the pdf content using langchain for responses
- conversation history saved in dynamodb
- user authentication via amazon cognito
- backend powered by express.js

## tech stack
- **backend**: express.js, node.js, aws lambda, langchain
- **storage**: amazon s3, dynamodb
- **authentication**: amazon cognito
- **pdf processing**: opencv
