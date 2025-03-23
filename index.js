require('dotenv').config();  // Load variables from .env file

const { Client, GatewayIntentBits } = require('discord.js');
const { joinVoiceChannel, getVoiceConnection, createAudioPlayer, AudioPlayerStatus } = require('@discordjs/voice');
const Prism = require('prism-media');
const { createAudioResource } = require('@discordjs/voice');

// Read variables from .env file
const AUTHORIZED_USER_ID = process.env.AUTHORIZED_USER_ID; // Specific user ID
const DECIBEL_THRESHOLD = 42.9; // Decibel threshold setting
const MUTE_COOLDOWN = 5000; // 5 second cooldown between mutes (adjust as needed)

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages, // For commands
        GatewayIntentBits.MessageContent, // For reading message content
    ],
});

// Track active monitoring streams to clean up properly
const activeStreams = new Map();
// Track when a user was last muted to prevent rapid re-muting
let lastMuteTime = 0;
// Track if monitoring is currently active
let isMonitoring = false;

client.once('ready', async () => {
    console.log('Bot is connected and ready!');
    console.log(`Monitoring specific user with ID: ${AUTHORIZED_USER_ID}`);
    
    // Check if target user is already in a voice channel on startup
    try {
        // Loop through all guilds the bot is in
        for (const guild of client.guilds.cache.values()) {
            await guild.members.fetch(); // Make sure to load all members
            
            const member = guild.members.cache.get(AUTHORIZED_USER_ID);
            if (member && member.voice.channelId) {
                console.log(`[STARTUP] Target user found in voice channel ${member.voice.channel.name} in guild ${guild.name}`);
                joinAndMonitor(member.voice.channel, guild);
                break; // Found the user, no need to check other guilds
            }
        }
    } catch (error) {
        console.error('[ERROR] Error checking for target user on startup:', error);
    }
});

// Function that calculates decibel volume
function calculateVolume(data) {
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
        sum += Math.abs(data[i]);
    }
    let avg = sum / data.length;
    return 20 * Math.log10(avg + 1); // Calculate decibels
}

// Function to stop all active monitoring
function stopAllMonitoring() {
    console.log('[MONITOR] Stopping all audio monitoring');
    isMonitoring = false;
    
    // Clean up all active streams
    activeStreams.forEach((stream, userId) => {
        if (stream && typeof stream.destroy === 'function') {
            stream.destroy();
        }
    });
    
    // Clear the map
    activeStreams.clear();
}

// Function to analyze audio volume and perform muting
function processAudio(receiver, user) {
    if (!isMonitoring) {
        console.log(`[MONITOR] Monitoring is disabled, not processing audio`);
        return;
    }

    console.log(`[MONITOR] Starting to process audio for specific user: ${user.displayName} (${user.id})`);

    // Check if we already have an active stream for this user
    if (activeStreams.has(user.id)) {
        console.log(`[MONITOR] Already monitoring user ${user.displayName}, skipping duplicate`);
        return;
    }

    const audioStream = receiver.subscribe(user.id, { end: 'manual' });
    const pcmStream = new Prism.opus.Decoder({ frameSize: 960, channels: 1, rate: 48000 });

    // Store the stream for cleanup later
    activeStreams.set(user.id, audioStream);

    audioStream.pipe(pcmStream);

    // Variable to track continuous volume logging
    let volumeSampleCount = 0;
    const LOG_INTERVAL = 10; // Log every 10 samples to prevent console spam

    pcmStream.on('data', (chunk) => {
        // Check if monitoring is still active
        if (!isMonitoring) {
            audioStream.destroy();
            return;
        }

        // Check if we have a chunk
        if (!chunk || chunk.length === 0) {
            return;
        }

        // Calculate audio volume in dB
        let volume = calculateVolume(chunk);
        
        // Increment sample counter
        volumeSampleCount++;
        
        // Log a message to console with the volume
        if (volumeSampleCount % LOG_INTERVAL === 0) {
            console.log(`[VOLUME] ${user.displayName} is speaking at ${volume.toFixed(2)} dB`);
        }

        // Check if user is already muted
        if (user.voice.serverMute) {
            return; // Skip if already muted
        }

        // Check cooldown period
        const now = Date.now();
        if (now - lastMuteTime < MUTE_COOLDOWN) {
            return; // Skip if we're in cooldown period
        }

        // If threshold is exceeded, mute
        if (volume > DECIBEL_THRESHOLD) {
            console.log(`[ALERT] ${user.displayName} exceeded the threshold (${volume.toFixed(2)} dB), muting!`);
            lastMuteTime = now;
            
            user.voice.setMute(true, 'Noise level too high!').catch(error => {
                console.error('[ERROR] Failed to mute user:', error);
            });
        }
    });

    pcmStream.on('error', (err) => {
        console.error('[ERROR] Error in audio processing function:', err);
        // Clean up on error
        if (activeStreams.has(user.id)) {
            activeStreams.delete(user.id);
        }
    });
    
    // Handle end of stream
    audioStream.on('end', () => {
        console.log(`[MONITOR] Audio stream ended for user: ${user.displayName}`);
        // Clean up
        if (activeStreams.has(user.id)) {
            activeStreams.delete(user.id);
        }
    });
}

// Function to join a voice channel and set up monitoring
function joinAndMonitor(channel, guild) {
    try {
        // First check if we're already connected to this channel
        const existingConnection = getVoiceConnection(guild.id);
        if (existingConnection && existingConnection.joinConfig.channelId === channel.id) {
            console.log(`[BOT] Already in voice channel ${channel.name}, not rejoining`);
            isMonitoring = true;
            return existingConnection;
        }
        
        // If we're connected to a different channel, destroy that connection first
        if (existingConnection) {
            existingConnection.destroy();
        }
        
        // Create new connection
        const connection = joinVoiceChannel({
            channelId: channel.id,
            guildId: guild.id,
            adapterCreator: guild.voiceAdapterCreator,
            selfDeaf: false,
            selfMute: false
        });
        
        console.log(`[BOT] Automatically joined voice channel ${channel.name} to monitor specific user`);
        
        // Enable monitoring
        isMonitoring = true;
        
        // Monitor audio for the specific user
        const receiver = connection.receiver;
        
        // Add connection state change listener to detect disconnects
        connection.on('stateChange', (oldState, newState) => {
            console.log(`[CONNECTION] Connection state changed from ${oldState.status} to ${newState.status}`);
            if (newState.status === 'disconnected') {
                stopAllMonitoring();
                console.log('[CONNECTION] Bot was disconnected from voice channel');
            }
        });
        
        // Set up speaking event
        receiver.speaking.on('start', (userId) => {
            if (userId === AUTHORIZED_USER_ID && isMonitoring) {
                console.log(`[EVENT] Specific user started speaking`);
                const user = guild.members.cache.get(userId);
                if (user) processAudio(receiver, user);
            }
        });
        
        return connection;
    } catch (error) {
        console.error('[ERROR] Error joining voice channel:', error);
        return null;
    }
}

// Managing event - when a user's voice status changes
client.on('voiceStateUpdate', async (oldState, newState) => {
    // Check if this is the specific user we're monitoring
    if (newState.member.id === AUTHORIZED_USER_ID || oldState.member.id === AUTHORIZED_USER_ID) {
        // Log the event for debugging
        console.log(`[DEBUG] Voice state update for user ${oldState.member.displayName || newState.member.displayName}`);
        console.log(`[DEBUG] Old channel: ${oldState.channelId ? oldState.channel.name : 'None'}`);
        console.log(`[DEBUG] New channel: ${newState.channelId ? newState.channel.name : 'None'}`);
        
        // Case 1: User joined a voice channel (was not in a channel before, now is in a channel)
        if (!oldState.channelId && newState.channelId) {
            console.log(`[EVENT] Target user ${newState.member.displayName} joined channel ${newState.channel.name}`);
            await joinAndMonitor(newState.channel, newState.guild);
        }
        
        // Case 2: User left a voice channel (was in a channel before, now is not in a channel)
        else if (oldState.channelId && !newState.channelId) {
            console.log(`[EVENT] Target user ${oldState.member.displayName} left voice channel ${oldState.channel.name}`);
            
            // Clean up monitoring for this user
            if (activeStreams.has(AUTHORIZED_USER_ID)) {
                const stream = activeStreams.get(AUTHORIZED_USER_ID);
                if (stream) {
                    stream.destroy();
                }
                activeStreams.delete(AUTHORIZED_USER_ID);
            }
            
            // Leave the voice channel automatically when user leaves
            const connection = getVoiceConnection(oldState.guild.id);
            if (connection) {
                console.log(`[BOT] Automatically leaving voice channel because target user left`);
                stopAllMonitoring();
                connection.destroy();
            }
        }
        
        // Case 3: User moved to a different channel
        else if (oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId) {
            console.log(`[EVENT] Target user ${newState.member.displayName} moved from ${oldState.channel.name} to ${newState.channel.name}`);
            
            // Clean up old monitoring
            if (activeStreams.has(AUTHORIZED_USER_ID)) {
                const stream = activeStreams.get(AUTHORIZED_USER_ID);
                if (stream) {
                    stream.destroy();
                }
                activeStreams.delete(AUTHORIZED_USER_ID);
            }
            
            // Follow the user to the new channel
            await joinAndMonitor(newState.channel, newState.guild);
        }
    }
});

// Keep the commands for manual control
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;  // If author is a bot, do nothing
    
    if (message.content.toLowerCase() === '!EP_join') {
        console.log('[COMMAND] Received !EP_join command');
        if (message.member && message.member.voice.channel) {
            await joinAndMonitor(message.member.voice.channel, message.guild);
            message.reply(`Joined voice channel ${message.member.voice.channel.name}!`);
        } else {
            message.reply('You need to be in a voice channel for me to join you!');
        }
    }

    if (message.content.toLowerCase() === '!EP_leave') {
        console.log('[COMMAND] Received !EP_leave command');
        try {
            const connection = getVoiceConnection(message.guild.id);
            if (connection) {
                stopAllMonitoring();
                connection.destroy();
                console.log('[BOT] Left the voice channel!');
                message.reply('Left the voice channel!');
            } else {
                message.reply('I am not connected to a voice channel right now!');
            }
        } catch (error) {
            console.error('[ERROR] Error leaving voice channel:', error);
            message.reply('Error leaving voice channel. Check console for details.');
        }
    }

    if (message.content.toLowerCase() === '!unmute') {
        console.log('[COMMAND] Received !unmute command');
        try {
            const guild = message.guild;
            const member = guild.members.cache.get(AUTHORIZED_USER_ID);
            if (member && member.voice.serverMute) {
                await member.voice.setMute(false, 'Manual unmute command');
                message.reply(`Unmuted ${member.displayName}!`);
            } else {
                message.reply('The user is not currently muted or not in a voice channel.');
            }
        } catch (error) {
            console.error('[ERROR] Error unmuting user:', error);
            message.reply('Error unmuting user. Check console for details.');
        }
    }

    if (message.content.toLowerCase() === '!pausemonitor') {
        console.log('[COMMAND] Received !pausemonitor command');
        isMonitoring = false;
        message.reply('Audio monitoring paused!');
    }

    if (message.content.toLowerCase() === '!resumemonitor') {
        console.log('[COMMAND] Received !resumemonitor command');
        isMonitoring = true;
        message.reply('Audio monitoring resumed!');
    }
    
    // Add a status command to see where things stand
    if (message.content.toLowerCase() === '!status') {
        console.log('[COMMAND] Received !status command');
        const connection = getVoiceConnection(message.guild.id);
        const targetMember = message.guild.members.cache.get(AUTHORIZED_USER_ID);
        let statusMsg = "Current Status:\n";
        
        statusMsg += `- Monitoring active: ${isMonitoring ? "Yes" : "No"}\n`;
        statusMsg += `- Bot connected to voice: ${connection ? "Yes" : "No"}\n`;
        statusMsg += `- Bot channel: ${connection ? client.channels.cache.get(connection.joinConfig.channelId).name : "None"}\n`;
        statusMsg += `- Target user in voice: ${targetMember && targetMember.voice.channelId ? "Yes" : "No"}\n`;
        if (targetMember && targetMember.voice.channelId) {
            statusMsg += `- Target user channel: ${targetMember.voice.channel.name}\n`;
        }
        statusMsg += `- Active monitoring streams: ${activeStreams.size}`;
        
        message.reply(statusMsg);
    }
});

// Clean up on process exit
process.on('SIGINT', () => {
    console.log('[SHUTDOWN] Bot is shutting down, cleaning up connections...');
    stopAllMonitoring();
    client.destroy();
    process.exit(0);
});

// Start the bot with your token
client.login(process.env.DISCORD_TOKEN); // Load token from .env file





// Function to list all users in a voice channel with their IDs
/*function listUsersInVoiceChannel(channel) {
    if (!channel || !channel.members) {
        return 'No valid voice channel provided';
    }
    
    console.log(`[INFO] Listing all users in channel: ${channel.name}`);
    
    let userList = `Users in channel ${channel.name}:\n`;
    let count = 0;
    
    // Loop through all members in the voice channel
    channel.members.forEach(member => {
        count++;
        userList += `${count}. ${member.displayName} (ID: ${member.id})`;
        
        // Add a special marker if this is the monitored user
        if (member.id === AUTHORIZED_USER_ID) {
            userList += ' [Monitored User]';
        }
        
        userList += '\n';
    });
    
    // Add total count at the end
    userList += `\nTotal users: ${count}`;
    
    return userList;
}

// Add this command to the messageCreate event handler
client.on('messageCreate', async (message) => {
    // Keep the existing commands...
    
    // Add the new command for listing users
    if (message.content.toLowerCase() === '!listusers') {
        console.log('[COMMAND] Received !listusers command');
        
        try {
            // Check if the command sender is in a voice channel
            if (message.member && message.member.voice.channel) {
                // Get the list of users in the sender's voice channel
                const userList = listUsersInVoiceChannel(message.member.voice.channel);
                message.reply(userList);
            } 
            // If not in a voice channel but bot is connected somewhere, list users there
            else {
                const connection = getVoiceConnection(message.guild.id);
                if (connection) {
                    const channel = client.channels.cache.get(connection.joinConfig.channelId);
                    const userList = listUsersInVoiceChannel(channel);
                    message.reply(userList);
                } else {
                    message.reply('אתה לא נמצא בערוץ קולי, והבוט גם לא מחובר לערוץ כלשהו.');
                }
            }
        } catch (error) {
            console.error('[ERROR] Error listing users:', error);
            message.reply('אירעה שגיאה בהצגת רשימת המשתמשים. בדוק את הקונסול לפרטים נוספים.');
        }
    }
    
    // Add another command to check a specific voice channel by ID
    if (message.content.toLowerCase().startsWith('!listusers ')) {
        console.log('[COMMAND] Received !listusers with channel ID');
        
        try {
            // Extract the channel ID from the command
            const channelId = message.content.split(' ')[1];
            const channel = message.guild.channels.cache.get(channelId);
            
            if (channel && channel.type === 2) { // 2 is the type for voice channels
                const userList = listUsersInVoiceChannel(channel);
                message.reply(userList);
            } else {
                message.reply(`הערוץ עם ID ${channelId} אינו קיים או אינו ערוץ קולי.`);
            }
        } catch (error) {
            console.error('[ERROR] Error listing users for specific channel:', error);
            message.reply('אירעה שגיאה בהצגת רשימת המשתמשים. בדוק את הקונסול לפרטים נוספים.');
        }
    }
});*/