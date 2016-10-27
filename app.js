/**
 * Copyright 2015 IBM Corp. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

require('dotenv').config({
    silent: true
});

var express = require('express'); // app server
var bodyParser = require('body-parser'); // parser for post requests
var watson = require('watson-developer-cloud'); // watson sdk
var fs = require('fs');
var credentials = JSON.parse(fs.readFileSync('./credentials.json', 'utf8'));
var alchemy_language = watson.alchemy_language({
    'api_key': credentials['credentials']['apikey']
});
var alchemy_data_news = watson.alchemy_data_news({
    'api_key': credentials['credentials']['apikey']
});

var stringSimilarity = require('string-similarity');

// The following requires are needed for logging purposes
var uuid = require('uuid');
var vcapServices = require('vcap_services');
var basicAuth = require('basic-auth-connect');

// Constants
const RETRIEVE_ARTICLES = true;
const MIN_KEYWORD_RELEVANCE = 0.5;
const USE_ALCHEMY_NEWS = false;
const MIN_PERSON_SIMILARITY = 0.5;
const MIN_KEYWORD_SIMILARITY = 0.2;

// The app owner may optionally configure a cloudand db to track user input.
// This cloudand db is not required, the app will operate without it.
// If logging is enabled the app must also enable basic auth to secure logging
// endpoints
var cloudantCredentials = vcapServices.getCredentials('cloudantNoSQLDB');
var cloudantUrl = null;
if (cloudantCredentials) {
    cloudantUrl = cloudantCredentials.url;
}
cloudantUrl = cloudantUrl || process.env.CLOUDANT_URL; // || '<cloudant_url>';
var logs = null;
var app = express();

// Bootstrap application settings
app.use(express.static('./public')); // load UI from public folder
app.use(bodyParser.json());

// Create the conversation service wrapper
var conversation = watson.conversation({
    url: 'https://gateway.watsonplatform.net/conversation/api',
    username: process.env.CONVERSATION_USERNAME || '<username>',
    password: process.env.CONVERSATION_PASSWORD || '<password>',
    version_date: '2016-07-11',
    version: 'v1'
});

// Endpoint to be call from the client side
app.post('/api/message', function(req, res) {
    var workspace = process.env.WORKSPACE_ID || '<workspace-id>';
    if (!workspace || workspace === '<workspace-id>') {
        return res.json({
            'output': {
                'text': 'The app has not been configured with a <b>WORKSPACE_ID</b> environment variable. Please refer to the ' +
                    '<a href="https://github.com/watson-developer-cloud/conversation-simple">README</a> documentation on how to set this variable. <br>' +
                    'Once a workspace has been defined the intents may be imported from ' +
                    '<a href="https://github.com/watson-developer-cloud/conversation-simple/blob/master/training/car_workspace.json">here</a> in order to get a working application.'
            }
        });
    }
    var payload = {
        workspace_id: workspace,
        context: {},
        input: {}
    };
    if (req.body) {
        if (req.body.input) {
            payload.input = req.body.input;
        }
        if (req.body.context) {
            // The client must maintain context/state
            payload.context = req.body.context;
        }
    }
    // Send the input to the conversation service
    conversation.message(payload, function(err, data) {
        if (err) {
            return res.status(err.code || 500).json(err);
        }

        console.log(JSON.stringify(data));
        if (!data.input.text) {
            return res.json(updateMessage(payload, data));
        }
        return parseInput(payload, data, res);

    });
});

// call alchemy language to discern concepts
function parseInput(payload, data, res) {
    var currDate = new Date();
    var parameters = {
        extract: 'entities,keywords,dates',
        text: data.input.text,
        anchorDate: currDate.toISOString().substring(0, 10) + ' 00:00:00'
    };
    alchemy_language.combined(parameters, function(err, response) {
        if (err) {
            console.log('Alchemy Language error:', err);
            data.output.text += '<br>' + 'Alchemy Language error: ' + JSON.stringify(err);
        } else {
            var hasEntity = (response.entities && response.entities.length > 0);
            var hasKeyword = (response.keywords && response.keywords.length > 0);
            var hasDate = (response.dates && response.dates.length > 0);

            var person = {};
            var startDate = 'now-1y';
            var keywords = [];

            // retrieve previous parameters from context
            console.log(JSON.stringify(data.context));
            if (data.context.person) {
                person = data.context.person;
            }
            if (data.context.startDate) {
                startDate = data.context.startDate;
            }
            if (data.context.keywords) {
                keywords = data.context.keywords;
                console.log(JSON.stringify(keywords));
            }

            // if the input has usable language, continue parsing
            // if not, send default message
            if (hasEntity || hasKeyword || hasDate) {
                console.log(JSON.stringify(response));
                data.output.text = '<h0>' + 'Parsing with Alchemy Language...' + '</h0>';

                if (hasEntity) {
                    person = parsePerson(response.entities, data);
                    if (person) {
                        data.context.person = person;
                    }
                }

                // check if a start date was mentioned, otherwise set to 1 year
                if (hasDate) {
                    startDate = parseDate(response.dates, data);
                    data.context.startDate = startDate;
                }

                if (hasKeyword) {
                    var ignoreText = [person.text];
                    keywords = parseKeywords(response.keywords, ignoreText, data);
                    data.context.keywords = keywords;
                }

                if (RETRIEVE_ARTICLES) {
                    if (person.name && keywords.length > 0) {
                        console.log("Attempting document retrieval")
                        var params = {
                            q: {
                                enriched: {
                                    url: {
                                        relations: {
                                            relation: {
                                                object: {
                                                    keywords: {
                                                        keyword: {
                                                            text: keywords[0].text
                                                        }
                                                    }
                                                },
                                                subject: {
                                                    keywords: {
                                                        keyword: {
                                                            text: person.name
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            },
                            rank: 'high',
                            start: startDate,
                            end: 'now',
                            count: 50,
                            return: 'enriched.url.url,enriched.url.title,enriched.url.relations.relation'
                        };
                        return getRelations(payload, data, params, res);

                    } else if (!person.name && keywords.length === 0) {
                        data.output.text += '<br>' + 'Please enter a name and topic to continue.';
                    } else if (!person.name) {
                        data.output.text += '<br>' + 'Please enter a name to continue.';
                    } else if (keywords.length === 0) {
                        data.output.text += '<br>' + 'Please enter a topic to continue.';
                    }
                }
            }

        }
        return res.json(updateMessage(payload, data));

    });
}

function parsePerson(entities, data) {
    // look through entities to find the first person
    var person = {};
    for (var i = 0, length = entities.length; i < length; i++) {
        if (entities[i].type == 'Person') {
            person = entities[i];
            break;
        }
    }
    if (person != {}) {
        console.log(JSON.stringify(person));
        person.name = person.text;
        // Set the person's name equal to the disambiguated name if possible
        if (person.disambiguated && person.disambiguated.name) {
            person.name = person.disambiguated.name;
        }

        console.log('Found person: ' + person.name);
        data.output.text += '<br>' + '<h0>' + 'Found person: ' + person.name  + '</h0>';
    } else {
        console.log('Could not find a person');
        data.output.text += '<br>' + 'Could not find a person';
    }
    return person;
}

function parseDate(dates, data) {
    // turn found date string into a Date obj
    var dateString = dates[0].date;
    console.log('Response date: ' + dateString);

    var year = dateString.substring(0, 4);
    var month = dateString.substring(4, 6) - 1;
    var day = dateString.substring(6, 8);
    var foundDate = new Date(year, month, day);

    var dayInMillisec = 24 * 60 * 60 * 1000;
    var currDate = new Date();
    var dateDifference = Math.round(Math.abs(
        (currDate.getTime() - foundDate.getTime()) / dayInMillisec));
    console.log('Found a date difference of ' + dateDifference + ' days');
    data.output.text += '<br>' + '<h0>' + 'Found date of earliest articles to search for: ' + foundDate.toDateString() + '</h0>';
    return 'now-' + dateDifference + 'd';

}

function parseKeywords(keywords, ignoreText, data) {
    // remove any keywords found in the ignoreText array
    console.log(JSON.stringify(keywords));

    keywords = keywords.filter(function(element) {
        return (ignoreText.indexOf(element.text) < 0) && (element.relevance >= MIN_KEYWORD_RELEVANCE);
    });
    console.log(JSON.stringify(keywords));
    for (var i = 0, length = keywords.length; i < length; i++) {
        data.output.text += '<br>' + '<h0>' + 'Found keyword: ' + keywords[i].text + '</h0>';
    }

    return keywords;
}

//Pulled from the following StackOverflow answer:
//http://stackoverflow.com/questions/1885557/simplest-code-for-array-intersection-in-javascript
function intersection(a, b) {
    var result = [];
    while (a.length > 0 && b.length > 0) {
        if (a[0] < b[0]) {
            a.shift();
        } else if (a[0] > b[0]) {
            b.shift();
        } else /* they're equal */ {
            result.push(a.shift());
            b.shift();
        }
    }
    return result.length;
}


function getRelations(payload, data, params, res) {
    if (USE_ALCHEMY_NEWS) {
        // make a call to alchemy data news with concept data
        alchemy_data_news.getNews(params, function(err, news) {
            if (err) {
                console.log('Alchemy news error:', err);
                data.output.text += '<br>' + 'Alchemy news error: ' + JSON.stringify(err);
            } else {
                data = parseRelations(data, params, news);
            } //end of 'else' block
            return res.json(updateMessage(payload, data));
        });
    } else {
        //pull from preloaded JSON object
        var news = JSON.parse(fs.readFileSync('GetNews.json', 'utf8'));
        data = parseRelations(data, params, news);
        return res.json(updateMessage(payload, data));
    }
}

function parseRelations(data, params, news) {
    //Alias the subject and object strings
    var subj = params.q.enriched.url.relations.relation.subject.keywords.keyword.text;
    var obj = params.q.enriched.url.relations.relation.object.keywords.keyword.text;

    //Filter docs
    var results = news.result.docs.filter(function(doc) {
        var _resultsRelevance = {};
        //Filter relations for each doc
        var _results = doc.source.enriched.url.relations.filter(function(relation) {
            var hasSubj = false;
            var hasObj = false;
            var sentence = relation.sentence;
            //try
            //Iterate over all entities in the relation's subject group
            if (relation.subject.entities) {
                if (relation.subject.entities.length > 0) {
                    relation.subject.entities.forEach(function(entity) {
                        //If the entity is disambiguated and shares a name, then it must be the subject
                        if (entity.text) {
                        //TODO: generalize to subj instead of preselected strings
                            var similarity = stringSimilarity.compareTwoStrings(entity.text, subj)
                            if(similarity > MIN_PERSON_SIMILARITY) {
                                hasSubj = true;
                                _resultsRelevance[sentence] = similarity;
                                console.log("Match on subject entity name: " + subj);
                            }
                        }
                    });
                //catch(err){}
                //try
                //Iterate over all keywords in the relation's object group
                }
            }
            if (relation.object.keywords) {
                if (relation.object.keywords.length > 0){
                    relation.object.keywords.forEach(function(keyword) {
                        //If the keyword contains the object text, then it's likely what we're looking for
                        if (keyword.text) {
                            var similarity = stringSimilarity.compareTwoStrings(keyword.text, obj);
                            if(similarity > MIN_KEYWORD_SIMILARITY) {
                                hasObj = true;
                                if (_resultsRelevance[sentence]) {
                                    _resultsRelevance[sentence] = _resultsRelevance[sentence] + similarity;
                                }
                                console.log("Match on object keyword: " + obj);
                            }
                        }
                    });
                //catch(err){}
                //If the relation has both a subject and object we're interested in, then it's good
                }
            }
            if (hasSubj && hasObj) {
                console.log("FOUND RELATION");
                return true;
            }
            return false;
        }); //end of var _results = doc.source.enriched.url.relations.filter

        console.log(JSON.stringify("_resultsRelevance: " + JSON.stringify(_resultsRelevance)));
        //If at least one relation for the doc was captured, add the doc to the list
        if (_results.length != 0) {
            //find most relevant relation
            var mostRelevant = Object.keys(_resultsRelevance).reduce(function(a, b){ return obj[a] > obj[b] ? a : b });
            console.log("Most relevant relation with " + _resultsRelevance[mostRelevant] + ' relevance is: ' + mostRelevant);
            var urlData = doc.source.enriched.url;
            data.output.text += '<br>' + 'Found article: ' + urlData.title;
            data.output.text += '<br>' + '<h0>' + 'via: <a href=' + urlData.url + '>' + urlData.url + '</a>' + '</h0>';
            data.output.text += '<br>' + 'Found relaitonal sentence with relevance of ' + _resultsRelevance[mostRelevant] + ': ' + mostRelevant;
            return true;
        }
    });
    return data;
}

/**
 * Updates the response text using the intent confidence
 * @param  {Object} input The request to the Conversation service
 * @param  {Object} response The response from the Conversation service
 * @return {Object}          The response with the updated message
 */
function updateMessage(input, response) {


    /*
    var _ = require('underscore');
    var parameters = {
      extract: 'entities,keywords,concepts,taxonomy,typed-rels',
      sentiment: 1,
      maxRetrieve: 1,
      model: 'en-news',
      text: input['input']['text']
    };
    alchemy_language.combined(parameters, function (err, response) {
      if (err)
        console.log('error:', err);
      else
        console.log(JSON.stringify(response, null, 2));
    });
    */

    var responseText = null;
    var id = null;
    if (!response.output) {
        response.output = {};
    } else {
        if (logs) {
            // If the logs db is set, then we want to record all input and responses
            id = uuid.v4();
            logs.insert({
                '_id': id,
                'request': input,
                'response': response,
                'time': new Date()
            });
        }
        return response;
    }
    if (response.intents && response.intents[0]) {
        var intent = response.intents[0];
        // Depending on the confidence of the response the app can return different messages.
        // The confidence will vary depending on how well the system is trained. The service will always try to assign
        // a class/intent to the input. If the confidence is low, then it suggests the service is unsure of the
        // user's intent . In these cases it is usually best to return a disambiguation message
        // ('I did not understand your intent, please rephrase your question', etc..)
        if (intent.confidence >= 0.75) {
            responseText = 'I understood your intent was ' + intent.intent;
        } else if (intent.confidence >= 0.5) {
            responseText = 'I think your intent was ' + intent.intent;
        } else {
            responseText = 'I did not understand your intent';
        }
    }
    response.output.text = responseText;
    if (logs) {
        // If the logs db is set, then we want to record all input and responses
        id = uuid.v4();
        logs.insert({
            '_id': id,
            'request': input,
            'response': response,
            'time': new Date()
        });
    }
    return response;
}

if (cloudantUrl) {
    // If logging has been enabled (as signalled by the presence of the cloudantUrl) then the
    // app developer must also specify a LOG_USER and LOG_PASS env vars.
    if (!process.env.LOG_USER || !process.env.LOG_PASS) {
        throw new Error('LOG_USER OR LOG_PASS not defined, both required to enable logging!');
    }
    // add basic auth to the endpoints to retrieve the logs!
    var auth = basicAuth(process.env.LOG_USER, process.env.LOG_PASS);
    // If the cloudantUrl has been configured then we will want to set up a nano client
    var nano = require('nano')(cloudantUrl);
    // add a new API which allows us to retrieve the logs (note this is not secure)
    nano.db.get('car_logs', function(err) {
        if (err) {
            console.error(err);
            nano.db.create('car_logs', function(errCreate) {
                console.error(errCreate);
                logs = nano.db.use('car_logs');
            });
        } else {
            logs = nano.db.use('car_logs');
        }
    });

    // Endpoint which allows deletion of db
    app.post('/clearDb', auth, function(req, res) {
        nano.db.destroy('car_logs', function() {
            nano.db.create('car_logs', function() {
                logs = nano.db.use('car_logs');
            });
        });
        return res.json({
            'message': 'Clearing db'
        });
    });

    // Endpoint which allows conversation logs to be fetched
    app.get('/chats', auth, function(req, res) {
        logs.list({
            include_docs: true,
            'descending': true
        }, function(err, body) {
            console.error(err);
            // download as CSV
            var csv = [];
            csv.push(['Question', 'Intent', 'Confidence', 'Entity', 'Output', 'Time']);
            body.rows.sort(function(a, b) {
                if (a && b && a.doc && b.doc) {
                    var date1 = new Date(a.doc.time);
                    var date2 = new Date(b.doc.time);
                    var t1 = date1.getTime();
                    var t2 = date2.getTime();
                    var aGreaterThanB = t1 > t2;
                    var equal = t1 === t2;
                    if (aGreaterThanB) {
                        return 1;
                    }
                    return equal ? 0 : -1;
                }
            });
            body.rows.forEach(function(row) {
                var question = '';
                var intent = '';
                var confidence = 0;
                var time = '';
                var entity = '';
                var outputText = '';
                if (row.doc) {
                    var doc = row.doc;
                    if (doc.request && doc.request.input) {
                        question = doc.request.input.text;
                    }
                    if (doc.response) {
                        intent = '<no intent>';
                        if (doc.response.intents && doc.response.intents.length > 0) {
                            intent = doc.response.intents[0].intent;
                            confidence = doc.response.intents[0].confidence;
                        }
                        entity = '<no entity>';
                        if (doc.response.entities && doc.response.entities.length > 0) {
                            entity = doc.response.entities[0].entity + ' : ' + doc.response.entities[0].value;
                        }
                        outputText = '<no dialog>';
                        if (doc.response.output && doc.response.output.text) {
                            outputText = doc.response.output.text.join(' ');
                        }
                    }
                    time = new Date(doc.time).toLocaleString();
                }
                csv.push([question, intent, confidence, entity, outputText, time]);
            });
            res.csv(csv);
        });
    });
}

module.exports = app;
