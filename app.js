/** DERIVED FROM <REPOSITORY/DIRECTORY> */
var watson = require('watson-developer-cloud');
var fs = require('fs');
var credentials = JSON.parse(fs.readFileSync('./credentials.json', 'utf8'));
var alchemy_language = watson.alchemy_language({'api_key': credentials['credentials']['apikey']});
var _ = require('underscore');



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