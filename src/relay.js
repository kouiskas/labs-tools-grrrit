var _ = require('underscore'),
    irc = require('irc'),
    redis = require('redis'),
    swig = require('swig'),
    processors = require('./preprocess.js'),
    yaml = require('js-yaml'),
    logging = require('winston'),
    config = require('../config.yaml'),
    conns = require('../connections.yaml'),
    // Sane? defaults
    config_defaults = {
        nick: 'grrrit',
        server: 'chat.freenode.net'
    };

_.defaults(config, config_defaults);

function errorLog(message) {
    logging.error(message);
}

swig.init({
    filters: require('./colors.js'),
    autoescape: false,
    root: __dirname
});

logging.add(logging.transports.File, {
    filename: process.env.HOME + '/logs/lolrrit-wm.log',
    json: false
});
logging.remove(logging.transports.Console);

var allChannels = _.keys(config.channels);

if(allChannels.indexOf(config['default-channel']) === -1) {
    allChannels.push(config['default-channel']);
}

if(typeof config['firehose-channel'] !== "undefined" && allChannels.indexOf(config['firehose-channel']) === -1) {
    allChannels.push(config['firehose-channel']);
}

logging.info("joining channels", allChannels);

function channelsForRepo(repo, branch) {
    var channels = [];
    _.each(config.channels, function(repos, channel) {
        _.each(repos, function(repo_config, repo_candidate) {
            if((new RegExp(repo_candidate)).test(repo)) {
                if(!_.isEmpty(repo_config) && _.has(repo_config, 'branch')) {
                    // Test if specified regex matches current branch
                    if((new RegExp(repo_config.branch)).test(branch)) {
                        channels.push(channel);
                    }
                } else {
                    channels.push(channel);
                }
            }
        });
    });
    if(!channels.length) {
        channels = [config['default-channel']];
    }
    if(typeof config['firehose-channel'] !== "undefined") {
        channels.push(config['firehose-channel']);
    }
    return channels;
}

var template = swig.compileFile('template.txt');

var ircClient = new irc.Client(config.server, config.nick, {
    userName: config.userName,
    realName: config.realName,
    password: config.password,
    channels: allChannels,
    stripColors: false,
    floodProtection: true
});
ircClient.addListener('error', errorLog);

var joinedChannels = [];
function waitForChannelJoins(channel, nick, message) {
    if(nick === config.nick) {
        joinedChannels.push(channel);
        logging.info("Joined channel " + channel);
    }
    if(joinedChannels.length === allChannels.length) {
        ircClient.removeListener('join', waitForChannelJoins);
        logging.info("Joined " + joinedChannels.length + " channels. Starting relay");
        startRelay();
    }
}
ircClient.addListener('join', waitForChannelJoins);
function startRelay() {
    var redisClient = redis.createClient(conns.redis.port, conns.redis.host);
    redisClient.addListener('error', errorLog);

    function doEcho() {
        redisClient.brpop(conns.redis['queue-key'], 0, function(err, reply) {
            var message;

            if(err) {
                logging.error("Caught error in redisClient.brpop: " + err);
                doEcho();
                return;
            }

            try {
                message = JSON.parse(reply[1]);
            } catch (e) {
                logging.error("Failed to parse as JSON: " + reply[1]);
                doEcho();
                return;
            }
            if(processors[message.type]) {
                var msg = processors[message.type](message);

                if(msg) {
                    if(config.blacklist.indexOf(msg.user) === -1) {
                        var relayMsg = template.render(msg).replace(/\s+/gm, ' ');
                        var channels = channelsForRepo(message.change.project, message.change.branch);
                        console.log(channels.length);
                        _.each(channels, function(channel) {
                            ircClient.say(channel, relayMsg);
                            logging.info("Sent message from " + msg.repo + " to " + channel);
                        });
                    }
                }
            }
            doEcho();
        });
    }

    redisClient.select(conns.redis.db, function() {
        doEcho();
    });
}
