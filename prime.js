const { Client, GatewayIntentBits, REST, Routes, EmbedBuilder } = require('discord.js');
const { ethers } = require('ethers');
const assignValueRoles = require('./server/public/js/assignValueRoles');
const sessionManager = require('./server/sessionManager');
const userDataManager = require('./server/userDataManager');
const Redis = require('ioredis');
require('dotenv').config();

const redisClient = new Redis({
    host: process.env.REDIS_HOST,
    port: process.env.REDIS_PORT,
    password: process.env.REDIS_PASSWORD,
});

redisClient.on('connect', () => {
    console.log('Connected to Redis');
});

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
    ]
});

const nftVerificationContract = new ethers.Contract(
    process.env.CONTRACT_ADDRESS,
    require('./server/abi.json'),
    new ethers.providers.JsonRpcProvider(process.env.ETHEREUM_RPC_URL)
);

const commands = [
    {
        name: 'verify',
        description: 'Verify your wallet and NFT ownership',
        options: [
            {
                name: 'walletaddress',
                type: 3, // STRING
                description: 'Your wallet address',
                required: true
            },
            {
                name: 'nftaddress',
                type: 3, // STRING
                description: 'NFT contract address',
                required: true
            }
        ]
    },
    {
        name: 'continue',
        description: 'Continue the verification process'
    },
    {
        name: 'updateallroles',
        description: 'Update roles for all users in the server based on the specified NFT address',
        options: [
            {
                name: 'nftaddress',
                type: 3, // STRING
                description: 'NFT contract address',
                required: true
            }
        ]
    },
    {
        name: 'addnft',
        description: 'Add an NFT'
    },
    {
        name: 'removenft',
        description: 'Remove an NFT'
    },
    {
        name: 'checkusernfts',
        description: 'Check NFTs owned by a user',
        options: [
            {
                name: 'username',
                type: 3, // STRING
                description: 'Discord username',
                required: true
            }
        ]
    },
    {
        name: 'registerrole',
        description: 'Register a role for an NFT'
    },
    {
        name: 'unregisterrole',
        description: 'Unregister a role for an NFT'
    },
    {
        name: 'mapnftvalue',
        description: 'Map a value to an NFT',
        options: [
            {
                name: 'nftaddress',
                type: 3, // STRING
                description: 'NFT contract address',
                required: true
            },
            {
                name: 'tokenid',
                type: 3, // STRING
                description: 'Token ID',
                required: true
            },
            {
                name: 'value',
                type: 4, // INTEGER
                description: 'Value to map',
                required: true
            }
        ]
    },
    {
        name: 'registervaluerole',
        description: 'Register a value-based role for an NFT'
    },
    {
        name: 'unregistervaluerole',
        description: 'Unregister a value-based role for an NFT'
    }
];

client.once('ready', async () => {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);
    try {
        console.log('Started refreshing application (/) commands.');

        await rest.put(
            Routes.applicationCommands(client.user.id),
            { body: commands }
        );

        console.log('Successfully reloaded application (/) commands.');
    } catch (error) {
        console.error(error);
    }

    console.log('Discord Bot is ready!');
});client.on('interactionCreate', async interaction => {
    if (!interaction.isCommand()) return;

    const { commandName, options } = interaction;

    try {
        if (commandName === 'verify') {
            await interaction.deferReply({ ephemeral: true });
            const walletAddress = options.getString('walletaddress');
            const nftAddress = options.getString('nftaddress');

            if (!ethers.utils.isAddress(walletAddress) || !ethers.utils.isAddress(nftAddress)) {
                return interaction.editReply({ content: 'Invalid wallet or NFT address provided.', ephemeral: true });
            }

            const verificationId = sessionManager.generateUUID();
            const verificationUrl = `${process.env.WEB_SERVER_URL}/verify?token=${verificationId}`;

            sessionManager.storeVerificationData(verificationId, {
                discordId: interaction.user.id,
                username: interaction.user.username,
                walletAddress,
                nftAddress,
                verified: false,
                interactionId: interaction.id,
                interactionToken: interaction.token,
                guildId: interaction.guild.id
            });

            await interaction.editReply({ content: `Please [click here](${verificationUrl}) to verify your wallet and NFT ownership.`, ephemeral: true });

        } else if (commandName === 'continue') {
            await interaction.deferReply({ ephemeral: true });
            const userId = interaction.user.id;
            const verificationData = await sessionManager.retrieveVerificationDataByDiscordId(userId);

            if (!verificationData) {
                return interaction.editReply({ content: 'Please complete the wallet verification first or ensure all data was submitted correctly.', ephemeral: true });
            }

            try {
                const walletAddress = verificationData.walletAddress;
                const nftAddress = verificationData.nftAddress;
                console.log(`Verifying ownership for wallet: ${walletAddress} and NFT: ${nftAddress}`);

                const [isOwner, count] = await nftVerificationContract.verifyOwnershipWithCount(walletAddress, nftAddress);
                console.log(`Is Owner: ${isOwner}, Count: ${count}`);

                if (isOwner) {
                    const rolesData = await nftVerificationContract.getRolesForNFT(nftAddress);
                    const roles = rolesData.map(role => role.roleName);

                    if (roles.length > 0) {
                        const guild = await client.guilds.fetch(interaction.guild.id);
                        const member = await guild.members.fetch(userId);

                        const roleObjects = roles.map(role => guild.roles.cache.find(r => r.name === role)).filter(Boolean);

                        await member.roles.add(roleObjects);
                        await interaction.editReply({ content: `NFT ownership verified and roles assigned: ${roles.join(', ')}`, ephemeral: true });

                        await sessionManager.deleteVerificationData(verificationData.interactionToken);
                    } else {
                        console.log('No standard roles found for the given NFT. Checking for value-based roles...');

                        const { eligible, roleName } = await assignValueRoles.assignRolesBasedOnValue(walletAddress, nftAddress, count);

                        if (eligible) {
                            console.log(`User is eligible for the value-based role: ${roleName}`);
                            const guild = await client.guilds.fetch(interaction.guild.id);
                            const member = await guild.members.fetch(userId);

                            const role = guild.roles.cache.find(r => r.name === roleName);
                            if (role) {
                                console.log(`Assigning role: ${roleName} to user ${interaction.user.username}`);
                                try {
                                    await member.roles.add(role);
                                    console.log(`Role ${roleName} successfully assigned to ${interaction.user.username}`);
                                    await interaction.editReply({ content: `NFT value-based ownership verified and role assigned: ${roleName}`, ephemeral: true });
                                } catch (roleAssignError) {
                                    console.error(`Error assigning role: ${roleAssignError}`);
                                    await interaction.editReply({ content: `Error assigning role: ${roleAssignError.message}`, ephemeral: true });
                                }
                            } else {
                                console.log(`Role not found in guild: ${roleName}`);
                                await interaction.editReply({ content: `Role ${roleName} could not be found in the server.`, ephemeral: true });
                            }
                        } else {
                            console.log('User does not meet the value requirements for any roles.');
                            await interaction.editReply({ content: 'You do not meet the value requirements for any roles.', ephemeral: true });
                        }

                        await sessionManager.deleteVerificationData(verificationData.interactionToken);
                    }
                } else {
                    await interaction.editReply({ content: 'NFT ownership could not be verified.', ephemeral: true });
                }
            } catch (error) {
                console.error('NFT verification failed:', error);
                await interaction.editReply({ content: `NFT verification failed: ${error.message}. Please try again.`, ephemeral: true });
            }

            const { cleanRedisKeys } = require('./server/public/js/cleanRedis');
            await cleanRedisKeys();
            console.log('Ran cleanRedisKeys successfully.');} else if (commandName === 'updateallroles') {
            await interaction.deferReply({ ephemeral: true });
            const guildId = interaction.guild.id;
            const nftAddressInput = options.getString('nftaddress');

            try {
                if (!ethers.utils.isAddress(nftAddressInput)) {
                    throw new Error("Invalid NFT address provided.");
                }
                const nftAddress = ethers.utils.getAddress(nftAddressInput);
                console.log(`NFT Address: ${nftAddress}`);

                // Track actions
                const results = {
                    totalProcessed: 0,
                    standardRolesAssigned: [],
                    valueRolesAssigned: [],
                    rolesRemoved: [],
                    errors: []
                };

                const userKeys = await redisClient.keys('user:*');
                if (userKeys.length === 0) {
                    return interaction.editReply({ content: 'No users registered in this guild for role updates.', ephemeral: true });
                }

                const processedUsers = new Set();

                for (const userKey of userKeys) {
                    const userData = JSON.parse(await redisClient.get(userKey));
                    const { discordId, username, walletAddresses, guildIds } = userData;

                    if (processedUsers.has(discordId) || !guildIds.includes(guildId)) {
                        continue;
                    }

                    try {
                        const guild = await client.guilds.fetch(guildId);
                        const member = await guild.members.fetch(discordId);

                        let isOwnerOfAny = false;
                        let maxCount = 0;
                        let ownerWallet = '';

                        for (const walletAddress of walletAddresses) {
                            try {
                                const walletAddressChecksum = ethers.utils.getAddress(walletAddress);
                                const [isOwner, count] = await nftVerificationContract.verifyOwnershipWithCount(walletAddressChecksum, nftAddress);
                                
                                if (isOwner && count > maxCount) {
                                    isOwnerOfAny = true;
                                    maxCount = count;
                                    ownerWallet = walletAddressChecksum;
                                }
                            } catch (walletError) {
                                console.error(`Error checking wallet ${walletAddress}:`, walletError);
                            }
                        }

                        if (isOwnerOfAny) {
                            console.log(`User owns NFTs in wallet: ${ownerWallet}, Count: ${maxCount}`);

                            // Check standard roles first
                            const rolesData = await nftVerificationContract.getRolesForNFT(nftAddress);
                            const standardRoles = rolesData.map(role => role.roleName);

                            if (standardRoles.length > 0) {
                                // Filter out roles that don't exist in the guild
                                const existingRoleObjects = standardRoles
                                    .map(role => {
                                        const found = guild.roles.cache.find(r => r.name === role);
                                        if (!found) {
                                            console.log(`Role '${role}' not found in guild - skipping assignment`);
                                            return null;
                                        }
                                        return found;
                                    })
                                    .filter(Boolean);

                                // Only proceed if we found any existing roles
                                if (existingRoleObjects.length > 0) {
                                    await member.roles.add(existingRoleObjects);
                                    const assignedRoles = existingRoleObjects.map(r => r.name).join(', ');
                                    results.standardRolesAssigned.push(`${username} (${assignedRoles})`);
                                }
                            } else {
                                console.log('No standard roles found for the given NFT. Checking for value-based roles...');
                            }

                            // Check value-based roles
                            const { eligible, roleName } = await assignValueRoles.assignRolesBasedOnValue(ownerWallet, nftAddress, maxCount);

                            if (eligible && roleName) {
                                const role = guild.roles.cache.find(r => r.name === roleName);
                                if (!role) {
                                    console.log(`Value-based role '${roleName}' not found in guild - skipping assignment`);
                                } else {
                                    const hasRole = member.roles.cache.has(role.id);
                                    if (!hasRole) {
                                        await member.roles.add(role);
                                        results.valueRolesAssigned.push(`${username} (${maxCount} NFTs)`);
                                    }
                                }
                            } else {
                                const citizenRole = guild.roles.cache.find(r => r.name === 'Citizen');
                                if (citizenRole && member.roles.cache.has(citizenRole.id)) {
                                    await member.roles.remove(citizenRole);
                                    results.rolesRemoved.push(`${username} (Insufficient Value)`);
                                }
                            }
                        } else {
                            // Remove roles if user no longer owns any NFTs
                            const citizenRole = guild.roles.cache.find(r => r.name === 'Citizen');
                            if (citizenRole && member.roles.cache.has(citizenRole.id)) {
                                await member.roles.remove(citizenRole);
                                results.rolesRemoved.push(`${username} (No NFTs)`);
                            }
                        }

                        results.totalProcessed++;
                        processedUsers.add(discordId);

                    } catch (userError) {
                        console.error(`Error processing user ${userData.username}:`, userError);
                        results.errors.push(username);
                    }
                }

                // Build response message
                let responseMessage = '**Role Update Complete**\n\n';
                
                if (results.standardRolesAssigned.length > 0) {
                    responseMessage += '**Standard Roles Assigned:**\n';
                    results.standardRolesAssigned.forEach(entry => {
                        responseMessage += `• ${entry}\n`;
                    });
                }

                if (results.valueRolesAssigned.length > 0) {
                    responseMessage += '\n**Value-Based Roles Assigned:**\n';
                    results.valueRolesAssigned.forEach(entry => {
                        responseMessage += `• ${entry}\n`;
                    });
                }

                if (results.rolesRemoved.length > 0) {
                    responseMessage += '\n**Roles Removed:**\n';
                    results.rolesRemoved.forEach(entry => {
                        responseMessage += `• ${entry}\n`;
                    });
                }

                if (results.errors.length > 0) {
                    responseMessage += '\n**Errors Processing:**\n';
                    results.errors.forEach(username => {
                        responseMessage += `• ${username}\n`;
                    });
                }

                if (responseMessage === '**Role Update Complete**\n\n') {
                    responseMessage = 'Role update complete. No changes were required.';
                }

                // Send response, splitting if needed
                if (responseMessage.length > 2000) {
                    const chunks = responseMessage.match(/.{1,1900}/g);
                    await interaction.editReply({ content: chunks[0] + "\n*(Continued...)*", ephemeral: true });
                    for (let i = 1; i < chunks.length; i++) {
                        await interaction.followUp({ content: chunks[i], ephemeral: true });
                    }
                } else {
                    await interaction.editReply({ content: responseMessage, ephemeral: true });
                }

            } catch (error) {
                console.error('Role update failed:', error);
                await interaction.editReply({ content: `Role update failed: ${error.message}. Please try again.`, ephemeral: true });
            }} else if (commandName === 'checkusernfts') {
            await interaction.deferReply({ ephemeral: true });
            const requestedUsername = options.getString('username');
            
            try {
                // Get user data from Redis
                const userKeys = await redisClient.keys('user:*');
                let userData = null;

                for (const key of userKeys) {
                    const data = JSON.parse(await redisClient.get(key));
                    if (data.username.toLowerCase() === requestedUsername.toLowerCase()) {
                        userData = data;
                        break;
                    }
                }

                if (!userData) {
                    return interaction.editReply({ content: `No data found for user ${requestedUsername}`, ephemeral: true });
                }

                const { walletAddresses } = userData;
                let responseLines = [`**NFT Holdings for ${requestedUsername}**\n`];

                for (const walletAddress of walletAddresses) {
                    try {
                        const walletAddressChecksum = ethers.utils.getAddress(walletAddress);
                        responseLines.push(`\n**Wallet: ${walletAddressChecksum}**`);

                        // Check registered NFT addresses
                        for (const nftAddress of userData.nftAddresses) {
                            try {
                                const nftAddressChecksum = ethers.utils.getAddress(nftAddress);
                                const [isOwner, count] = await nftVerificationContract.verifyOwnershipWithCount(walletAddressChecksum, nftAddressChecksum);
                                
                                if (isOwner && count > 0) {
                                    responseLines.push(`• ${nftAddressChecksum}: ${count} NFTs`);
                                }
                            } catch (nftError) {
                                console.error(`Error checking NFT address ${nftAddress}:`, nftError);
                                responseLines.push(`Error checking NFT ${nftAddress}: ${nftError.message}`);
                            }
                        }
                    } catch (walletError) {
                        console.error(`Error checking wallet ${walletAddress}:`, walletError);
                        responseLines.push(`Error checking wallet ${walletAddress}: ${walletError.message}`);
                    }
                }

                // If no NFTs were found
                if (responseLines.length === 1) {
                    responseLines.push('No NFTs found for this user.');
                }

                const response = responseLines.join('\n');

                // Split response if too long
                if (response.length > 2000) {
                    const chunks = response.match(/.{1,1900}/g);
                    await interaction.editReply({ content: chunks[0] + "\n*(Continued...)*", ephemeral: true });
                    for (let i = 1; i < chunks.length; i++) {
                        await interaction.followUp({ content: chunks[i], ephemeral: true });
                    }
                } else {
                    await interaction.editReply({ content: response, ephemeral: true });
                }

            } catch (error) {
                console.error('Error in checkusernfts:', error);
                await interaction.editReply({ content: `Error checking NFTs: ${error.message}. Please try again.`, ephemeral: true });
               }
            } else if (commandName === 'addnft') {
            await interaction.deferReply({ ephemeral: true });
            const url = `${process.env.WEB_SERVER_URL}/addnft`;
            await interaction.editReply({ content: `Please [click here](${url}) to add an NFT.`, ephemeral: true });
        } else if (commandName === 'removenft') {
            await interaction.deferReply({ ephemeral: true });
            const url = `${process.env.WEB_SERVER_URL}/removenft`;
            await interaction.editReply({ content: `Please [click here](${url}) to remove an NFT.`, ephemeral: true });
        } else if (commandName === 'registerrole') {
            await interaction.deferReply({ ephemeral: true });
            const url = `${process.env.WEB_SERVER_URL}/registerrole`;
            await interaction.editReply({ content: `Please [click here](${url}) to register a role for an NFT.`, ephemeral: true });
        } else if (commandName === 'unregisterrole') {
            await interaction.deferReply({ ephemeral: true });
            const url = `${process.env.WEB_SERVER_URL}/unregisterrole`;
            await interaction.editReply({ content: `Please [click here](${url}) to unregister a role for an NFT.`, ephemeral: true });
        } else if (commandName === 'mapnftvalue') {
            await interaction.deferReply({ ephemeral: true });
            const nftAddress = options.getString('nftaddress');
            const tokenId = options.getString('tokenid');
            const value = options.getInteger('value');

            if (!ethers.utils.isAddress(nftAddress)) {
                return interaction.editReply({ content: 'Invalid NFT address provided.', ephemeral: true });
            }

            try {
                await nftVerificationContract.mapNFTValue(nftAddress, tokenId, value);
                await interaction.editReply({ content: 'NFT value mapped successfully.', ephemeral: true });
            } catch (error) {
                console.error('Error mapping NFT value:', error);
                await interaction.editReply({ content: `Error mapping NFT value: ${error.message}`, ephemeral: true });
            }
        } else if (commandName === 'registervaluerole') {
            await interaction.deferReply({ ephemeral: true });
            const url = `${process.env.WEB_SERVER_URL}/registervaluerole`;
            await interaction.editReply({ content: `Please [click here](${url}) to register a value-based role for an NFT.`, ephemeral: true });
        } else if (commandName === 'unregistervaluerole') {
            await interaction.deferReply({ ephemeral: true });
            const url = `${process.env.WEB_SERVER_URL}/unregistervaluerole`;
            await interaction.editReply({ content: `Please [click here](${url}) to unregister a value-based role for an NFT.`, ephemeral: true });
        }
    } catch (error) {
        console.error('Error handling interaction:', error);
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: 'An error occurred while processing your request.', ephemeral: true });
        } else {
            await interaction.followUp({ content: 'An error occurred while processing your request.', ephemeral: true });
        }
    }
});

async function getRolesForTokenId(nftAddress, tokenId) {
    try {
        const roles = [];

        const nftRoles = await nftVerificationContract.getRolesForTokenId(nftAddress, tokenId);

        for (const role of nftRoles) {
            roles.push(role.roleName);
        }

        return roles;
    } catch (error) {
        console.error('Error fetching roles for token ID:', error);
        return [];
    }
}

client.login(process.env.DISCORD_BOT_TOKEN);
