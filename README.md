# ChatPDF
**ChatPDF** is a serverless application that allows users to upload PDFs, extract their content as text, and ask questions about the PDF using LangChain, with answers based on the PDF content.

## Features
- Upload PDFs and extract text
- Store PDF text in Amazon S3
- Ask questions about the PDF content using LangChain for responses
- Conversation history saved in DynamoDB
- User authentication via Amazon Cognito
- Backend powered by Express.js

## Tech Stack
- **Backend**: Express.js, Node.js, AWS Lambda, LangChain
- **Storage**: Amazon S3, DynamoDB
- **Authentication**: Amazon Cognito
- **PDF Processing**: OpenCV