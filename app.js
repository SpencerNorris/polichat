/*eslint-env node*/

//------------------------------------------------------------------------------
// node.js starter application for Bluemix
//------------------------------------------------------------------------------

var watson = require('watson-developer-cloud');
var fs = require('fs');
var credentials = JSON.parse(fs.readFileSync('./credentials.json', 'utf8'));
var alchemy_language = watson.alchemy_language({'api_key': credentials['credentials']['apikey']});
var _ = require('underscore');

// This application uses express as its web server
// for more info, see: http://expressjs.com
var express = require('express');

// cfenv provides access to your Cloud Foundry environment
// for more info, see: https://www.npmjs.com/package/cfenv
var cfenv = require('cfenv');

// create a new express server
var app = express();

// serve the files out of ./public as our main files
app.use(express.static(__dirname + '/public'));

// get the app environment from Cloud Foundry
var appEnv = cfenv.getAppEnv();

// start server on the specified port and binding host
app.listen(appEnv.port, '0.0.0.0', function() {
  // print a message when the server starts listening
  console.log("server starting on " + appEnv.url);
});



var parameters = {
  extract: 'entities,keywords,concepts,taxonomy,typed-rels',
  sentiment: 1,
  maxRetrieve: 1,
  model: 'en-news',
  text: 'What is Hillary Clinton\'s opinion on the Syrian refugee crisis?'
};

alchemy_language.combined(parameters, function (err, response) {
  if (err)
    console.log('error:', err);
  else
    console.log(JSON.stringify(response, null, 2));
});
