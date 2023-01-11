'use strict';

const { FilesReader, SkillsWriter, SkillsErrorEnum } = require('./skills-kit-2.0');
const Box = require("box-node-sdk");
const Axios = require("axios");
const { Configuration, OpenAIApi } = require("openai");
const {encode, decode} = require('gpt-3-encoder')

//DESCRIPTION: This Box Skill serverless function takes text from a file stored in Box and sends it to OpenAI's completion API endpoint to create a Skill card tl;dr summary. 
//In addition to this code, which is written to be deployed to a GCP function, you will need to set up a Box Skill in the Box developer console, authorize and configure the Box Skill, and set up an account with OpenAI.
//Visit the readme to find out more on the steps to deploy
//You can chose the open ai model selected on https://beta.openai.com/docs/models/gpt-3. This example uses davinci which maxes out at 4096 tokens. 

//environment variables
const boxPrimaryKey = process.env.box_primary_key;
const boxSecondaryKey = process.env.box_secondary_key;
const box_api_endpoint = process.env.box_api_endpoint;
const open_ai_model = process.env.open_ai_model;
const max_document_tokens = process.env.max_document_tokens;

exports.boxSkill = async (request, response) => {      
    const filesReader = new FilesReader(request.body);
    const skillsWriter = new SkillsWriter(filesReader.getFileContext());
    let text;
    let encoded;

        try{
            const body = JSON.stringify(request.body);
            console.log('Request Body: ', body);
            //Validate Bpx Signature Keys So Bad People Don't Use Your Endpoint
            let isValid = Box.validateWebhookMessage(request.body, request.headers, boxPrimaryKey, boxSecondaryKey);  
            if(isValid){
                //You can use this code to save a temporary processing skills card if using the skills card option
                await skillsWriter.saveProcessingCard();
                //function to download the text
                await downloadText();
                //function to count tokens
                await countTokens();
                //function to find the summary of the document and save it back to skill card
                await findSummary();
                console.log("Skill process completed.")
                // Skills engine requires a 200 response within 10 seconds of sending an event.
                response.status(200).send('Box event was processed by skill');
            } else {
                console.log('Keys Were Not Valid')
                response.status(401).send('Unauthorized');
            }

        } catch (error) {
            await skillsWriter.saveErrorCard(SkillsErrorEnum.UNKNOWN,"The text extract was not ready. It will retry again in a few minutes.");
            console.error(
                `Skill processing failed for file: ${filesReader.getFileContext().fileId} with error: ${error.message}`
            );
            response.status(400).send('Something went wrong. The process will retry via exponential backoff.');
        }

        async function downloadText() {
            //Build the file download url so that we can locally download the extracted text
            var textDownloadURL = `${box_api_endpoint}/${request.body.source.id}/versions/${request.body.source.file_version.id}/representations/extracted_text/content/?access_token=${request.body.token.read.access_token}`;
            console.log("download url: ", textDownloadURL);
            //Wait approx 5 seconds for Box to finish the text extract... maybe
            await new Promise(resolve => setTimeout(resolve, 5000));
            //Download text from Box
            var { data } = await Axios.get(textDownloadURL);
            //assign data to text variable
            text = data;
            //Check the string for how many tokens it will take
            encoded = encode(data);
            //Check to make sure there was text. If there is not, the text needs to be redownloaded.
            //Will send error back to back causing exponintial backoff retry.
            if (encoded.length == 0){
                throw new Error("Text extract not ready.");
            } else {
                console.log("Text Extracted Correctly.");
            }
        }

        async function countTokens () {
            console.log('This text contains this many tokens: ', encoded.length);
            //If the text exceeds the openai model token max, you need to reduce the text
            console.log('Max tokens: ', max_document_tokens);

            if (encoded.length >= max_document_tokens) {
                //start counter
                let i = 0;
                //reset text
                let textEdited = "";
                //loop through tokens and recombine text within appropriate limit
                for(let token of encoded){
                    if(i >= max_document_tokens){break};
                    textEdited = textEdited + decode([token]);
                    i++;
                }
                text = textEdited;
            }
        }

        async function findSummary() {
            //Create OpenAI configuration as defined in their developer documentation
            const configuration = new Configuration({
                apiKey: process.env.openai_sec_key,
                });
            const openai = new OpenAIApi(configuration);
            //Call OpenAI with text extracted from document
            const responseOpenAI = await openai.createCompletion({
                model: open_ai_model,
                prompt: text + "\n\ntl;dr",
                temperature: 0.7,
                max_tokens: 275,
                top_p: 1,
                frequency_penalty: 0,
                presence_penalty: 1,
            });
            if (responseOpenAI.data.choices[0].text){
                console.log("OpenAI Text: ", JSON.stringify(responseOpenAI.data.choices[0].text));
                //Create a transcript card with the tldr summary from OpenAI
                const cards = [];
                const mockListOfDiscoveredTranscripts = [{ text: responseOpenAI.data.choices[0].text }];
                cards.push(skillsWriter.createTranscriptsCard(mockListOfDiscoveredTranscripts));
                console.log(`cards ${JSON.stringify(cards)}`);
                //Write the card onto the file
                await skillsWriter.saveDataCards(cards);
            } else {
                await skillsWriter.saveErrorCard(SkillsErrorEnum.UNKNOWN);
            }
        }
};
