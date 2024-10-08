const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const session = require('express-session');
const RedisStore = require('connect-redis').default;
const redisClient = require('./redisClient');
const UAParser = require('ua-parser-js');

const verificationDataPath = path.join(__dirname, 'verification_data');
const userDataPath = path.join(__dirname, 'user_data');

if (!fs.existsSync(verificationDataPath)) {
    fs.mkdirSync(verificationDataPath);
}

if (!fs.existsSync(userDataPath)) {
    fs.mkdirSync(userDataPath);
}

function generateUUID() {
    return uuidv4();
}

async function storeVerificationData(token, data) {
    console.log(`Storing verification data for token: ${token}, data:`, data);
    await redisClient.set(`verification:${token}`, JSON.stringify(data), 'EX', 300); // 5 minutes expiration

    // Set a timer to delete the verification data after 5 minutes
    setTimeout(() => {
        deleteVerificationData(token);
    }, 5 * 60 * 1000); // 5 minutes
}

async function retrieveVerificationData(token) {
    const data = await redisClient.get(`verification:${token}`);
    if (data) {
        const parsedData = JSON.parse(data);
        console.log(`Retrieved verification data for token: ${token}, data:`, parsedData);
        return parsedData;
    }
    console.log(`No verification data found for token: ${token}`);
    return null;
}

async function retrieveVerificationDataByDiscordId(discordId) {
    const keys = await redisClient.keys('verification:*');
    for (const key of keys) {
        const data = await redisClient.get(key);
        if (data) {
            const parsedData = JSON.parse(data);
            if (parsedData.discordId === discordId) {
                console.log(`Retrieved verification data for discordId: ${discordId}, data:`, parsedData);
                return parsedData;
            }
        }
    }
    console.log(`No verification data found for discordId: ${discordId}`);
    return null;
}

async function deleteVerificationData(token) {
    await redisClient.del(`verification:${token}`);
    console.log(`Verification data for token ${token} has been deleted.`);
}

async function storeUserData(username, data, req) {
    const key = `user:${username}`;
    try {
        let existingData = await redisClient.get(key);
        if (existingData) {
            existingData = JSON.parse(existingData);
        } else {
            existingData = {
                discordId: data.discordId,
                username: username,
                walletAddresses: [],
                ipAddresses: [],
                guildIds: [],
                nftAddresses: [],
                osSessions: []
            };
        }

        // Ensure all arrays exist
        existingData.walletAddresses = existingData.walletAddresses || [];
        existingData.ipAddresses = existingData.ipAddresses || [];
        existingData.guildIds = existingData.guildIds || [];
        existingData.nftAddresses = existingData.nftAddresses || [];
        existingData.osSessions = existingData.osSessions || [];

        // Append new data if it doesn't already exist
        if (!existingData.walletAddresses.includes(data.walletAddress)) {
            existingData.walletAddresses.push(data.walletAddress);
        }
        if (!existingData.ipAddresses.includes(data.ipAddress)) {
            existingData.ipAddresses.push(data.ipAddress);
        }
        if (data.guildId && !existingData.guildIds.includes(data.guildId)) {
            existingData.guildIds.push(data.guildId);
        }
        if (data.nftAddress && !existingData.nftAddresses.includes(data.nftAddress)) {
            existingData.nftAddresses.push(data.nftAddress);
        }

        // Add OS fingerprinting
        if (req && req.headers['user-agent']) {
            const parser = new UAParser(req.headers['user-agent']);
            const osInfo = parser.getOS();
            const browserInfo = parser.getBrowser();
            const deviceInfo = parser.getDevice();

            existingData.osSessions.push({
                timestamp: new Date().toISOString(),
                os: osInfo.name + ' ' + osInfo.version,
                browser: browserInfo.name + ' ' + browserInfo.version,
                device: `${deviceInfo.vendor} ${deviceInfo.model} ${deviceInfo.type}`,
                ipAddress: data.ipAddress
            });
        }

        await redisClient.set(key, JSON.stringify(existingData));
        console.log(`Storing user data for username: ${username}, data:`, existingData);
    } catch (err) {
        console.error('Error storing user data:', err);
    }
}

async function retrieveUserData(username) {
    const key = `user:${username}`;
    try {
        const data = await redisClient.get(key);
        if (data) {
            console.log(`Retrieved user data for username: ${username}, data:`, JSON.parse(data));
            return JSON.parse(data);
        }
        console.log(`No user data found for username: ${username}`);
        return null;
    } catch (err) {
        console.error('Error retrieving user data:', err);
        return null;
    }
}

async function getAllUserData() {
    try {
        const keys = await redisClient.keys('user:*');
        const allUserData = [];
        for (const key of keys) {
            const data = await redisClient.get(key);
            if (data) {
                allUserData.push(JSON.parse(data));
            }
        }
        console.log('Retrieved all user data:', allUserData);
        return allUserData;
    } catch (err) {
        console.error('Error retrieving all user data:', err);
        return [];
    }
}

function setupSession() {
    const isProduction = process.env.NODE_ENV === 'production';

    return session({
        store: new RedisStore({ client: redisClient }),
        secret: process.env.SESSION_SECRET || 'your-secret-key',
        resave: false,
        saveUninitialized: false,
        cookie: {
            secure: isProduction,
            maxAge: 5 * 60 * 1000, // 5 minutes
            sameSite: isProduction ? 'None' : 'Lax'
        }
    });
}

function validateSession(req, res, next) {
    if (!req.session.userId) {
        return res.status(401).json({ message: 'Unauthorized: No session available' });
    }
    next();
}

module.exports = {
    generateUUID,
    storeVerificationData,
    retrieveVerificationData,
    retrieveVerificationDataByDiscordId,
    deleteVerificationData,
    storeUserData,
    retrieveUserData,
    getAllUserData,
    setupSession,
    validateSession
};