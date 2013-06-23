exports.ChatServer = function (sio, redisC, EventBus, Channels, ChannelModel) {

	var config = require('./config.js').Configuration,
		CHATSPACE = "/chat",
		async = require('async'),
		spawn = require('child_process').spawn,
		_= require('underscore'),
		fs = require('fs'),
		crypto = require('crypto'),
		PUBLIC_FOLDER = __dirname + '/../public',
		SANDBOXED_FOLDER = PUBLIC_FOLDER + '/sandbox',
		Client = require('../client/client.js').ClientModel,
		Clients = require('../client/client.js').ClientsCollection,
		ApplicationError = require('./Error'),
		REGEXES = require('../client/regex.js').REGEXES;

	var DEBUG = config.DEBUG;

	function urlRoot(){
		if (config.host.USE_PORT_IN_URL) {
			return config.host.SCHEME + "://" + config.host.FQDN + ":" + config.host.PORT + "/";
		} else {
			return config.host.SCHEME + "://" + config.host.FQDN + "/";
		}
	}

	function serverSentMessage (msg, room) {
		return _.extend(msg, {
			nickname: config.features.SERVER_NICK,
			type: "SYSTEM",
			timestamp: Number(new Date()),
			room: room
		});
	}

	function publishUserList (channel) {
		var room = channel.get("name"),
			authenticatedClients = channel.clients.where({authenticated: true}),
			clientsJson;

		// console.log(authenticatedClients.hasOwnProperty("toJSON"));
		
		sio.of(CHATSPACE).in(room).emit('userlist:' + room, {
			users: authenticatedClients,
			room: room
		});
	}

	function userJoined (client, room) {
		sio.of(CHATSPACE).in(room).emit('chat:' + room, serverSentMessage({
			body: client.get("nick") + ' has joined the chat.',
			client: client.toJSON(),
			class: "join",
			log: false
		}, room));
	}
	function userLeft (client, room) {
		sio.of(CHATSPACE).in(room).emit('chat:' + room, serverSentMessage({
			body: client.get("nick") + ' has left the chat.',
			id: client.get("id"),
			class: "part",
			log: false
		}, room));
	}

	function subscribeSuccess (socket, client, channel) {
		var room = channel.get("name");

		// add to server's list of authenticated clients
		// channel.clients.add(client);

		// tell the newly connected client know the ID of the latest logged message
		redisC.hget("channels:currentMessageID", room, function (err, reply) {
			if (err) throw err;
			socket.in(room).emit('chat:currentID:' + room, {
				ID: reply,
				room: room
			});
		});

		// tell the newly connected client the topic of the channel:
		redisC.hget('topic', room, function (err, reply){
			if (client.get("room") !== room) return;
			socket.in(room).emit('topic:' + room, serverSentMessage({
				body: reply,
				log: false,
			}, room));
		});

		// tell everyone about the new client in the room
		userJoined(client, room);

		// let the knewly joined know their ID
		socket.in(room).emit("client:id:" + room, {
			room: room,
			id: client.get("id")
		});

		// finally, announce to the client that he's now in the room
		socket.in(room).emit("chat:" + room, serverSentMessage({
			body: "Talking in channel '" + room + "'",
			log: false
		}, room));

		publishUserList(channel);
	}

	var ChatServer = require('./AbstractServer.js').AbstractServer(sio, redisC, EventBus, Channels, ChannelModel);

	ChatServer.initialize({
		name: "ChatServer",
		SERVER_NAMESPACE: CHATSPACE,
		events: {
			"make_public": function (namespace, socket, channel, client, data) {
				var room = channel.get("name");

				channel.makePublic(function (err, response) {
					if (err) {
						socket.in(room).emit('chat:' + room, serverSentMessage({
							body: err.message
						}, room));
						return;
					}
					
					socket.in(room).emit('chat:' + room, serverSentMessage({
						body: "This channel is now public."
					}, room));
				});
			},
			"make_private": function (namespace, socket, channel, client, data) {
				var room = channel.get("name");

				channel.makePrivate(data.password, function (err, response) {
					if (err) {
						socket.in(room).emit('chat:' + room, serverSentMessage({
							body: err.message
						}, room));				
						return;
					}
					
					socket.in(room).emit('chat:' + room, serverSentMessage({
						body: "This channel is now private.  Please remember your password."
					}, room));
				});

			},
			"join_private": function (namespace, socket, channel, client, data) {
				var password = data.password;
				var room = channel.get("name");

				channel.authenticate(client, password, function (err, response) {
					if (err) {
						if (err instanceof ApplicationError.Authentication) {
							if (err.message === "Incorrect password.") {
								// let everyone currently in the room know that someone failed to join it
								socket.in(room).broadcast.emit('chat:' + room, serverSentMessage({
									class: "identity",
									body: client.get("nick") + " just failed to join the room."
								}, room));
							}
						}
						// let the joiner know what went wrong:
						socket.in(room).emit('chat:' + room, serverSentMessage({
							body: err.message
						}, room));
						return;
					}
				});
			},
			"nickname": function (namespace, socket, channel, client, data, ack) {
				var room = channel.get("name");

				var newName = data.nickname.replace(REGEXES.commands.nick, "").trim(),
					prevName = client.get("nick");
				client.set("identified", false);

				if (newName === "") {
					socket.in(room).emit('chat:' + room, serverSentMessage({
						body: "You may not use the empty string as a nickname.",
						log: false
					}, room));
					return;
				}

				client.set("nick", newName);
				EventBus && EventBus.trigger("nickset." + socket.id, {
					nick: newName,
					color: client.get("color")
				});

				socket.in(room).broadcast.emit('chat:' + room, serverSentMessage({
					class: "identity",
					body: prevName + " is now known as " + newName,
					log: false
				}, room));
				socket.in(room).emit('chat:' + room, serverSentMessage({
					class: "identity",
					body: "You are now known as " + newName,
					log: false
				}, room));
				publishUserList(channel);
				ack();
			},
			"topic": function (namespace, socket, channel, client, data) {
				var room = channel.get("name");

				redisC.hset('topic', room, data.topic);
				socket.in(room).emit('topic:' + room, serverSentMessage({
					body: data.topic,
					log: false
				}, room));
			},
			"chat:history_request": function (namespace, socket, channel, client, data) {
				var room = channel.get("name"),
					jsonArray = [];

				redisC.hmget("chatlog:" + room, data.requestRange, function (err, reply) {
					if (err) throw err;
					// emit the logged replies to the client requesting them
					socket.in(room).emit('chat:batch:' + room, _.without(reply, null));
				});
			},
			"chat:idle": function (namespace, socket, channel, client, data) {
				var room = channel.get("name");

				client.set("idle", true);
				client.set("idleSince", Number(new Date()));
				data.id = client.get("id");
				sio.of(CHATSPACE).in(room).emit('chat:idle:' + room, data);
				publishUserList(channel);
			},
			"chat:unidle": function (namespace, socket, channel, client, data) {
				var room = channel.get("name");

				client.set("idle", false);
				client.unset("idleSince");
				sio.of(CHATSPACE).in(room).emit('chat:unidle:' + room, {
					id: client.get("id")
				});
				publishUserList(channel);
			},
			"private_message": function (namespace, socket, channel, client, data) {
				var targetClients;
				var room = channel.get("name");

				// only send a message if it has a body & is directed at someone
				if (data.body && data.directedAt) {
					data.id = client.get("id");
					data.color = client.get("color").toRGB();
					data.nickname = client.get("nick");
					data.timestamp = Number(new Date());
					data.type = "private";
					data.class = "private";

					targetClients = channel.clients.where({nick: data.directedAt}); // returns an array
					if (typeof targetClients !== "undefined" &&
						targetClients.length) {

						// send the pm to each client matching the name
						_.each(targetClients, function (client) {
							client.socketRef.emit('private_message:' + room, data);
						});
						// send it to the sender s.t. he knows that it went through
						socket.in(room).emit('private_message:' + room, _.extend(data, {
							you: true
						}));
					} else {
						// some kind of error message
					}
				}
			},
			"user:set_color": function (namespace, socket, channel, client, data) {
				var room = channel.get("name");

				client.get("color").parse(data.userColorString, function (err) {
					if (err) {
						socket.in(room).emit('chat:' + room, serverSentMessage({
							type: "SERVER",
							body: err.message
						}, room));
						return;
					}

					publishUserList(channel);
				});
			},
			"chat": function (namespace, socket, channel, client, data) {
				var room = channel.get("name");

				if (data.body) {
					data.id = client.get("id");
					data.color = client.get("color").toRGB();
					data.nickname = client.get("nick");
					data.timestamp = Number(new Date());

					// store in redis
					redisC.hget("channels:currentMessageID", room, function (err, reply) {
						if (err) throw err;

						var mID = 0;
						if (reply) {
							mID = parseInt(reply, 10);
						}
						redisC.hset("channels:currentMessageID", room, mID+1);

						data.ID = mID;

						// store the chat message
						redisC.hset("chatlog:" + room, mID, JSON.stringify(data), function (err, reply) {
							if (err) throw err;
						});

						socket.in(room).broadcast.emit('chat:' + room, data);
						socket.in(room).emit('chat:' + room, _.extend(data, {
							you: true
						}));

						if (config.features.PHANTOMJS_SCREENSHOT) {
							// strip out other things the client is doing before we attempt to render the web page
							var urls = data.body.replace(REGEXES.urls.image, "")
												.replace(REGEXES.urls.youtube,"")
												.match(REGEXES.urls.all_others);
							if (urls) {
								for (var i = 0; i < urls.length; i++) {
									
									var randomFilename = parseInt(Math.random()*9000,10).toString() + ".jpg";
									
									(function (url, fileName) { // run our screenshotting routine in a self-executing closure so we can keep the current filename & url
										var output = SANDBOXED_FOLDER + "/" + fileName,
											pageData = {};
										
										DEBUG && console.log("Processing ", urls[i]);
										// requires that the phantomjs-screenshot repo is a sibling repo of this one
										var screenshotter = spawn(config.features.PHANTOMJS_PATH,
											['../../phantomjs-screenshot/main.js', url, output],
											{
												cwd: __dirname
											});

										screenshotter.stdout.on('data', function (data) {
											DEBUG && console.log('screenshotter stdout: ' + data);
											data = data.toString(); // explicitly cast it, who knows what type it is having come from a process

											// attempt to extract any parameters phantomjs might expose via stdout
											var tmp = data.match(REGEXES.phantomjs.parameter);
											if (tmp && tmp.length) {
												var key = tmp[0].replace(REGEXES.phantomjs.delimiter, "").trim();
												var value = data.replace(REGEXES.phantomjs.parameter, "").trim();
												pageData[key] = value;
											}
										});
										screenshotter.stderr.on('data', function (data) {
											DEBUG && console.log('screenshotter stderr: ' + data);
										});
										screenshotter.on("exit", function (data) {
											DEBUG && console.log('screenshotter exit: ' + data);
											if (pageData.title && pageData.excerpt) {
												sio.of(CHATSPACE).in(room).emit('chat:' + room, serverSentMessage({
													body: '<<' + pageData.title + '>>: "'+ pageData.excerpt +'" (' + url + ') ' + urlRoot() + 'sandbox/' + fileName
												}, room));
											} else if (pageData.title) {
												sio.of(CHATSPACE).in(room).emit('chat:' + room, serverSentMessage({
													body: '<<' + pageData.title + '>> (' + url + ') ' + urlRoot() + 'sandbox/' + fileName
												}, room));
											} else {
												sio.of(CHATSPACE).in(room).emit('chat:' + room, serverSentMessage({
													body: urlRoot() + 'sandbox/' + fileName
												}, room));
											}
										});
									})(urls[i], randomFilename); // call our closure with our random filename
								}
							}
						}
					});
				}
			},
			"identify": function (namespace, socket, channel, client, data) {
				var room = channel.get("name");
				var nick = client.get("nick");
				try {
					redisC.sismember("users:" + room, nick, function (err, reply) {
						if (!reply) {
							socket.in(room).emit('chat:' + room, serverSentMessage({
								class: "identity",
								body: "There's no registration on file for " + nick
							}, room));
						} else {
							async.parallel({
								salt: function (callback) {
									redisC.hget("salts:" + room, nick, callback);
								},
								password: function (callback) {
									redisC.hget("passwords:" + room, nick, callback);
								}
							}, function (err, stored) {
								if (err) throw err;
								crypto.pbkdf2(data.password, stored.salt, 4096, 256, function (err, derivedKey) {
									if (err) throw err;

									if (derivedKey.toString() !== stored.password) { // FAIL
										client.set("identified", false);
										socket.in(room).emit('chat:' + room, serverSentMessage({
											class: "identity",
											body: "Wrong password for " + nick
										}, room));
										socket.in(room).broadcast.emit('chat:' + room, serverSentMessage({
											class: "identity",
											body: nick + " just failed to identify himself"
										}, room));
										publishUserList(channel);
									} else { // ident'd
										client.set("identified", true);
										socket.in(room).emit('chat:' + room, serverSentMessage({
											class: "identity",
											body: "You are now identified for " + nick
										}, room));
										publishUserList(channel);
									}
								});
							});
						}
					});
				} catch (e) { // identification error
					socket.in(room).emit('chat:' + room, serverSentMessage({
						body: "Error identifying yourself: " + e
					}, room));
				}
			},
			"register_nick": function (namespace, socket, channel, client, data) {
				var room = channel.get("name");
				var nick = client.get("nick");
				redisC.sismember("users:" + room, nick, function (err, reply) {
					if (err) throw err;
					if (!reply) { // nick is not in use
						try { // try crypto & persistence
							crypto.randomBytes(256, function (ex, buf) {
								if (ex) throw ex;
								var salt = buf.toString();
								crypto.pbkdf2(data.password, salt, 4096, 256, function (err, derivedKey) {
									if (err) throw err;

									redisC.sadd("users:" + room, nick, function (err, reply) {
										if (err) throw err;
									});
									redisC.hset("salts:" + room, nick, salt, function (err, reply) {
										if (err) throw err;
									});
									redisC.hset("passwords:" + room, nick, derivedKey.toString(), function (err, reply) {
										if (err) throw err;
									});

									client.set("identified", true);
									socket.in(room).emit('chat:' + room, serverSentMessage({
										body: "You have registered your nickname.  Please remember your password."
									}, room));
									publishUserList(channel);
								});
							});
						} catch (e) {
							socket.in(room).emit('chat:' + room, serverSentMessage({
								body: "Error in registering your nickname: " + e
							}, room));
						}
					} else { // nick is already in use
						socket.in(room).emit('chat:' + room, serverSentMessage({
							body: "That nickname is already registered by somebody."
						}, room));
					}
				});
			},
			"unsubscribe": function (namespace, socket, channel, client) {
				var room = channel.get("name");
				userLeft(client, room);
				channel.clients.remove(client);
				publishUserList(channel);
			}
		},
		unauthenticatedEvents: ["join_private"]
	});

	ChatServer.start({
		error: function (err, socket, channel, client) {
			var room = channel.get("name");

			if (err) {
				if (err instanceof ApplicationError.Authentication) {
					socket.in(room).emit("chat:" + room, serverSentMessage({
						body: "This channel is private.  Please type /password [channel password] to join"
					}, room));
					socket.in(room).emit("private:" + room);
				} else {
					socket.in(room).emit("chat:" + room, serverSentMessage({
						body: err.message
					}, room));

					DEBUG && console.log("ChatServer: ", err);
				}
				return;
			}
		},
		success: function (namespace, socket, channel, client) {
			DEBUG && console.log("Client joined ", channel.get("name"));
			subscribeSuccess(socket, client, channel);
		}
	});
};