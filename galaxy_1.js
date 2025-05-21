const WebSocket = require('ws');
const fs = require('fs').promises;
const fsSync = require('fs');
const CryptoJS = require('crypto-js');
const puppeteer = require('puppeteer'); // Added for prison automation
const path = require('path'); // Added for file path handling

// Configuration
let config;
let rivalNames = [];
let recoveryCode;
let userMap = {};
let reconnectAttempt = 0;
let currentMode = null;

let prisonBrowser = null;
let prisonPage = null;
let currentPrisonScriptResolve = null; // To hold the resolve function for the current prison script execution

// Connection pool settings
const MAX_POOL_SIZE = 2;
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BACKOFF_BASE = 100;
const connectionPool = [];
let activeConnection = null;
let poolWarmupInProgress = false;
let pauseConnectionPoolManagement = false; // New flag to pause connection pool management during prison automation

// Connection states
const CONNECTION_STATES = {
    CLOSED: 'closed',
    CONNECTING: 'connecting',
    CONNECTED: 'connected',
    HASH_RECEIVED: 'hash_received',
    AUTHENTICATED: 'authenticated',
    READY: 'ready'
};

// Attack and defense timing variables
let currentAttackTime;
let currentDefenceTime;
let monitoringMode = true;

// Prison automation variables
let prisonAutomationInProgress = false;
let planetName = ""; // Will be set to botId once authenticated

function updateConfigValues() {
    try {
        delete require.cache[require.resolve('./config1.json')];
        config = require('./config1.json');
        rivalNames = Array.isArray(config.rival) ? config.rival : config.rival.split(',').map(name => name.trim());
        recoveryCode = config.RC;
        
        currentAttackTime = config.startAttackTime;
        currentDefenceTime = config.startDefenceTime;
        
        console.log("Configuration updated:", { 
            rivalNames, 
            recoveryCode,
            attackSettings: {
                start: config.startAttackTime,
                stop: config.stopAttackTime,
                interval: config.attackIntervalTime,
                current: currentAttackTime
            },
            defenceSettings: {
                start: config.startDefenceTime,
                stop: config.stopDefenceTime,
                interval: config.defenceIntervalTime,
                current: currentDefenceTime
            }
        });
    } catch (error) {
        console.error("Error updating config:", error);
    }
}

updateConfigValues();

fsSync.watch('config1.json', (eventType) => {
    if (eventType === 'change') {
        console.log('Config file changed, updating values...');
        updateConfigValues();
    }
});

function genHash(code) {
    const hash = CryptoJS.MD5(code);
    let str = hash.toString(CryptoJS.enc.Hex);
    str = str.split("").reverse().join("0").substr(5, 10);
    return str;
}

function createConnection() {
    const conn = {
        socket: null,
        state: CONNECTION_STATES.CLOSED,
        hash: null,
        botId: null,
        lastUsed: Date.now(),
        authenticating: false,
        initPromise: null,
        reconnectAttempt: 0,
        createdAt: Date.now(),
        connectionTimeout: null,
        registrationData: null,
        
        send: function(str) {
            if (this.socket && this.socket.readyState === WebSocket.OPEN) {
                this.socket.send(str + "\r\n");
                console.log(`Sent [${this.botId || 'connecting'}]: ${str}`);
                this.lastUsed = Date.now();
                return true;
            } else {
                console.log(`Cannot send [${this.botId || 'connecting'}]: Socket not open (state: ${this.state})`);
                return false;
            }
        },
        
        initialize: function(stopAtHash = false) {
            if (this.initPromise) {
                return this.initPromise;
            }
            
            this.initPromise = new Promise((resolve, reject) => {
                try {
                    if (this.socket) {
                        this.cleanup();
                    }
                    
                    this.state = CONNECTION_STATES.CONNECTING;
                    this.authenticating = true;
                    console.log(`Initializing new connection (stopAtHash: ${stopAtHash})...`);
                    
                    this.socket = new WebSocket("wss://cs.mobstudio.ru:6672/", {
                        rejectUnauthorized: false,
                        handshakeTimeout: 3000
                    });
                    
                    this.connectionTimeout = setTimeout(() => {
                        console.log("Connection initialization timeout");
                        this.authenticating = false;
                        this.cleanup();
                        reject(new Error("Connection initialization timeout"));
                    }, 5000);
                    
                    this.socket.on('open', () => {
                        this.state = CONNECTION_STATES.CONNECTED;
                        console.log("WebSocket connected, initializing identity");
                        this.send(":ru IDENT 352 -2 4030 1 2 :GALA");
                    });
                    
                    this.socket.on('message', (data) => {
                        const message = data.toString().trim();
                        
                        if (stopAtHash && this.state === CONNECTION_STATES.HASH_RECEIVED) {
                            console.log(`Warm pool connection [${this.botId || 'connecting'}] received message but stopping at hash: ${message}`);
                            if (message.startsWith("REGISTER")) {
                                console.log("Storing registration data for later activation");
                                this.registrationData = message;
                                clearTimeout(this.connectionTimeout);
                                this.authenticating = false;
                                resolve(this);
                                return;
                            }
                        }
                        
                        this.handleMessage(message, resolve, reject, stopAtHash);
                    });
                    
                    this.socket.on('close', () => {
                        console.log(`WebSocket [${this.botId || 'connecting'}] closed (state: ${this.state})`);
                        if (this.authenticating) {
                            this.authenticating = false;
                            clearTimeout(this.connectionTimeout);
                            reject(new Error("Connection closed during authentication"));
                        }
                        this.state = CONNECTION_STATES.CLOSED;
                        const index = connectionPool.indexOf(this);
                        if (index !== -1) {
                            connectionPool.splice(index, 1);
                        }
                        if (this === activeConnection) {
                            console.log("Active connection closed, getting new connection immediately");
                            activeConnection = null;
                            Promise.resolve().then(() => {
                                return getConnection(true).catch(err => {
                                    console.error("Failed to get new connection after close:", err);
                                    return tryReconnectWithBackoff();
                                });
                            });
                        }
                    });
                    
                    this.socket.on('error', (error) => {
                        console.error(`WebSocket [${this.botId || 'connecting'}] error:`, error.message || error);
                        if (this.authenticating) {
                            this.authenticating = false;
                            clearTimeout(this.connectionTimeout);
                            reject(error);
                        }
                    });
                } catch (err) {
                    console.error("Error during connection initialization:", err);
                    clearTimeout(this.connectionTimeout);
                    this.authenticating = false;
                    reject(err);
                }
            }).finally(() => {
                this.initPromise = null;
            });
            
            return this.initPromise;
        },
        
        handleMessage: function(message, resolve, reject, stopAtHash = false) {
            try {
                console.log(`Received [${this.botId || 'connecting'}]: ${message}`);
                this.lastReceivedMessage = message;
				
				// Check for Prison mention in the message - add this code here
				if (message.includes('PRISON') || message.includes('Prison') || message.includes('Тюрьма')) {
					console.log(`🔒 Prison mention detected: "${message}"`);
					handlePrisonAutomation(this);
					return; // Skip further processing for prison handling
				}
        
                const colonIndex = message.indexOf(" :");
                let payload = colonIndex !== -1 ? message.substring(colonIndex + 2) : "";
                const parts = message.split(/\s+/);
                const command = parts[0];
                
                switch (command) {
                    case "PING":
                        this.send("PONG");
                        break;
                    case "HAAAPSI":
                        if (parts.length >= 2) {
                            const code = parts[1];
                            this.hash = genHash(code);
                            console.log(`Generated hash [${this.botId || 'connecting'}]: ${this.hash}`);
                            this.send(`RECOVER ${recoveryCode}`);
                            this.state = CONNECTION_STATES.HASH_RECEIVED;
                            if (stopAtHash) {
                                console.log(`Warm pool connection reached HASH_RECEIVED state`);
                            }
                        }
                        break;
                    case "REGISTER":
                        if (parts.length >= 4) {
                            this.botId = parts[1];
                            const password = parts[2];
                            const nick = parts[3];
                            if (stopAtHash) {
                                this.registrationData = message;
                                console.log(`Stored registration data for warm pool connection [${this.botId}]`);
                                clearTimeout(this.connectionTimeout);
                                this.authenticating = false;
                                resolve(this);
                                return;
                            }
                            if (this.hash) {
                                this.send(`USER ${this.botId} ${password} ${nick} ${this.hash}`);
                                console.log(`Authenticated with USER command [${this.botId}]`);
                            }
                        }
                        break;
                    case "999":
                        this.state = CONNECTION_STATES.AUTHENTICATED;
                        console.log(`Connection [${this.botId}] authenticated, sending setup commands...`);
                        
                        // Store botId as planetName for prison automation
                        planetName = config.planetName;
                        console.log(`Set planetName to: ${planetName}`);
                        
                        this.send("FWLISTVER 0");
                        this.send("ADDONS 0 0");
                        this.send("MYADDONS 0 0");
                        this.send("PHONE 0 0 0 2 :Node.js");
                        this.send("JOIN");
                        currentAttackTime = config.startAttackTime;
                        currentDefenceTime = config.startDefenceTime;
                        this.state = CONNECTION_STATES.READY;
                        this.authenticating = false;
                        reconnectAttempt = 0;
                        if (this.connectionTimeout) {
                            clearTimeout(this.connectionTimeout);
                            this.connectionTimeout = null;
                        }
                        console.log(`Connection [${this.botId}] is now READY`);
                        resolve(this);
                        break;
                    case "353":
                        parse353(message, this);
                        break;
                    case "JOIN":
                        handleJoinCommand(parts, this);
                        break;
                    case "PART":
                        if (parts.length >= 2) {
                            remove_user(parts[1]);
                        }
                        break;
                    case "KICK":
                        if (parts.length >= 3) {
                            remove_user(parts[2]);
                        }
                        break;
                    case "451":
                    case "452":
                        console.log(`Critical error ${command} [${this.botId || 'connecting'}]: ${message}`);
                        if (this.authenticating) {
                            this.authenticating = false;
                            clearTimeout(this.connectionTimeout);
                            this.cleanup();
                            console.log(`⚡ Got ${command} error, trying immediate recovery with warm connection...`);
                            reject(new Error(`Critical error ${command}`));
                            Promise.resolve().then(() => {
                                return getConnection(true).catch(err => {
                                    console.error(`Failed to get warm connection after ${command} error:`, err);
                                    return tryReconnectWithBackoff();
                                });
                            });
                            return;
                        }
                        this.cleanup();
                        break;
                    case "850":
                        if (payload.includes("3 секунд(ы)")) {
                            if (currentMode) {
                                if (currentMode === 'attack') {
                                    currentAttackTime += config.attackIntervalTime;
                                    if (currentAttackTime > config.stopAttackTime) {
                                        currentAttackTime = config.startAttackTime;
                                    }
                                    console.log(`Hit 3-second rule in attack mode, increased attack time to: ${currentAttackTime}ms`);
                                } else if (currentMode === 'defence') {
                                    currentDefenceTime += config.defenceIntervalTime;
                                    if (currentDefenceTime > config.stopDefenceTime) {
                                        currentDefenceTime = config.startDefenceTime;
                                    }
                                    console.log(`Hit 3-second rule in defence mode, increased defence time to: ${currentDefenceTime}ms`);
                                }
                            }
                        }
                        break;
                    case "999":
                        console.log(`Received 999 response: ${message}`);
                        break;
                }
            } catch (err) {
                console.error(`Error handling message [${this.botId || 'connecting'}]:`, err);
                if (this.authenticating) {
                    this.authenticating = false;
                    clearTimeout(this.connectionTimeout);
                    reject(err);
                }
            }
        },
        
        activateWarmConnection: function() {
            return new Promise((resolve, reject) => {
                try {
                    if (this.state !== CONNECTION_STATES.HASH_RECEIVED || !this.registrationData) {
                        reject(new Error("Cannot activate connection that isn't properly warmed up"));
                        return;
                    }
                    console.log(`⚡ Fast-activating warm connection [${this.botId || 'pending'}]...`);
                    this.authenticating = true;
                    this.connectionTimeout = setTimeout(() => {
                        console.log("Connection activation timeout");
                        this.authenticating = false;
                        reject(new Error("Connection activation timeout"));
                    }, 5000);
                    const parts = this.registrationData.split(/\s+/);
                    if (parts.length >= 4) {
                        this.botId = parts[1];
                        const password = parts[2];
                        const nick = parts[3];
                        if (this.hash) {
                            this.send(`USER ${this.botId} ${password} ${nick} ${this.hash}`);
                            console.log(`Activated warm connection with USER command [${this.botId}]`);
                            const originalOnMessage = this.socket.onmessage;
                            this.socket.onmessage = (event) => {
                                const message = event.data.toString().trim();
                                console.log(`Activation received: ${message}`);
                                if (message.startsWith("999")) {
                                    this.state = CONNECTION_STATES.AUTHENTICATED;
                                    console.log(`Warm connection [${this.botId}] authenticated, sending setup commands...`);
                                    this.send("FWLISTVER 0");
                                    this.send("ADDONS 0 0");
                                    this.send("MYADDONS 0 0");
                                    this.send("PHONE 0 0 0 2 :Node.js");
                                    this.send("JOIN");
                                    this.state = CONNECTION_STATES.READY;
                                    this.authenticating = false;
                                    reconnectAttempt = 0;
                                    if (this.connectionTimeout) {
                                        clearTimeout(this.connectionTimeout);
                                        this.connectionTimeout = null;
                                    }
                                    console.log(`⚡ Warm connection [${this.botId}] SUCCESSFULLY activated and READY`);
                                    this.socket.onmessage = originalOnMessage;
                                    resolve(this);
                                    return;
                                }
                                if (originalOnMessage) {
                                    originalOnMessage(event);
                                }
                            };
                        } else {
                            reject(new Error("No hash available for activation"));
                        }
                    } else {
                        reject(new Error("Invalid registration data for activation"));
                    }
                } catch (err) {
                    console.error("Error during warm connection activation:", err);
                    this.authenticating = false;
                    clearTimeout(this.connectionTimeout);
                    reject(err);
                }
            });
        },
        
        cleanup: function() {
            try {
                if (this.connectionTimeout) {
                    clearTimeout(this.connectionTimeout);
                    this.connectionTimeout = null;
                }
                if (this.socket) {
                    this.socket.removeAllListeners();
                    if ([WebSocket.OPEN, WebSocket.CONNECTING].includes(this.socket.readyState)) {
                        this.socket.terminate();
                    }
                    this.socket = null;
                }
                this.state = CONNECTION_STATES.CLOSED;
                this.authenticating = false;
            } catch (err) {
                console.error(`Error in cleanup [${this.botId || 'connecting'}]:`, err);
            }
        }
    };
    return conn;
}

function parse353(message, connection) {
    // Extract payload using the same logic from handleMessage
    const colonIndex = message.indexOf(" :");
    const payload = colonIndex !== -1 ? message.substring(colonIndex + 2) : "";
    
    console.log(`Parsing 353 message [${connection.botId}]: ${message}`);
    console.log(`Parsed payload: ${payload}`);
    
    // Check for Prison mention in the entire message
    if (message.includes('Prison') || message.includes('Тюрьма')) {
        console.log(`🔒 Prison mention detected: "${message}"`);
        handlePrisonAutomation(connection);
        return false; // Skip rival detection for prison handling
    }
    
    const tokens = payload.split(' ');
    let i = 0;
    let detectedRivals = [];
    
    while (i < tokens.length) {
        let name = tokens[i];
        let hasPrefix = false;
        
        if (name.length > 1 && (name.startsWith('@') || name.startsWith('+'))) {
            name = name.substring(1);
            hasPrefix = true;
        }
        
        i++;
        
        if (i < tokens.length && !isNaN(tokens[i])) {
            const id = tokens[i];
            userMap[name] = id;
            console.log(`Added to userMap [${connection.botId}]: ${name} -> ${id}`);
            if (rivalNames.includes(name)) {
                detectedRivals.push(name);
                console.log(`Detected rival [${connection.botId}]: ${name} with ID ${id}`);
            }
            i++;
        } else if (hasPrefix) {
            i--;
        }
    }
    
    if (detectedRivals.length > 0) {
        console.log(`Detected rivals in 353 [${connection.botId}]: ${detectedRivals.join(', ')} - Defence mode activated`);
        handleRivals(detectedRivals, 'defence', connection);
    } else {
        console.log(`No rivals detected in 353 [${connection.botId}], continuing to monitor`);
    }
    
    return detectedRivals.length > 0;
}

function handleJoinCommand(parts, connection) {
    if (parts.length >= 4) {
        let prefix = "";
        let name = "";
        let id = "";
        
        if (parts.length >= 5 && !isNaN(parts[3])) {
            prefix = parts[1];
            name = parts[2];
            id = parts[3];
        } else {
            name = parts[1];
            id = parts[2];
        }
        
        userMap[name] = id;
        console.log(`User ${name} joined with ID ${id} [${connection.botId}]`);
        
        if (rivalNames.includes(name)) {
            console.log(`Rival ${name} joined [${connection.botId}] - Attack mode activated`);
            handleRivals([name], 'attack', connection);
        }
    }
}

function remove_user(user) {
    if (userMap[user]) {
        delete userMap[user];
        console.log(`Removed user ${user} from userMap`);
    }
}

async function warmConnectionPool() {
    if (poolWarmupInProgress || pauseConnectionPoolManagement) {
        console.log(`Pool warmup skipped: ${poolWarmupInProgress ? 'already in progress' : 'pool management paused'}`);
        return;
    }
    
    try {
        poolWarmupInProgress = true;
        console.log(`Warming connection pool (current size: ${connectionPool.length}/${MAX_POOL_SIZE})`);
        
        const now = Date.now();
        const STALE_THRESHOLD = 5 * 60 * 1000;
        for (let i = connectionPool.length - 1; i >= 0; i--) {
            const conn = connectionPool[i];
            if (now - conn.lastUsed > STALE_THRESHOLD || 
                (conn.state !== CONNECTION_STATES.HASH_RECEIVED && conn.state !== CONNECTION_STATES.READY)) {
                console.log(`Pruning connection ${conn.botId || 'none'} from pool (State: ${conn.state}, Age: ${(now - conn.createdAt)/1000}s)`);
                conn.cleanup();
                connectionPool.splice(i, 1);
            }
        }
        
        const connectionsToAdd = Math.max(0, MAX_POOL_SIZE - connectionPool.length);
        if (connectionsToAdd > 0) {
            console.log(`Adding ${connectionsToAdd} new warm connection(s) to pool`);
            const batchSize = 5;
            for (let batch = 0; batch < Math.ceil(connectionsToAdd / batchSize); batch++) {
                const batchPromises = [];
                const batchStart = batch * batchSize;
                const batchEnd = Math.min((batch + 1) * batchSize, connectionsToAdd);
                for (let i = batchStart; i < batchEnd; i++) {
                    const conn = createConnection();
                    batchPromises.push((async () => {
                        try {
                            console.log(`Initializing pool connection ${i+1}/${connectionsToAdd} (warm mode)`);
                            await conn.initialize(true);
                            if (conn.state === CONNECTION_STATES.HASH_RECEIVED && conn.registrationData) {
                                connectionPool.push(conn);
                                console.log(`Added new warm connection to pool (total: ${connectionPool.length}/${MAX_POOL_SIZE})`);
                                return true;
                            } else {
                                console.warn(`Connection reached end of initialization but state is ${conn.state}, not adding to pool`);
                                conn.cleanup();
                                return false;
                            }
                        } catch (error) {
                            console.error(`Failed to initialize connection for pool:`, error.message || error);
                            conn.cleanup();
                            return false;
                        }
                    })());
                }
                await Promise.allSettled(batchPromises);
            }
        }
        console.log(`Connection pool warm-up complete. Pool size: ${connectionPool.length}/${MAX_POOL_SIZE}`);
    } catch (err) {
        console.error("Error in warmConnectionPool:", err);
    } finally {
        poolWarmupInProgress = false;
    }
}

async function getConnection(activateFromPool = true) {
    console.log(`Getting connection (activateFromPool: ${activateFromPool})...`);
    if (activeConnection && activeConnection.state === CONNECTION_STATES.READY) {
        console.log(`Reusing existing active connection ${activeConnection.botId}`);
        return activeConnection;
    }
    
    const warmConnections = connectionPool.filter(conn => 
        conn.state === CONNECTION_STATES.HASH_RECEIVED && conn.registrationData);
    console.log(`Warm connections available: ${warmConnections.length}/${connectionPool.length}`);
    
    let chosenConn = null;
    if (activateFromPool && warmConnections.length > 0) {
        let oldestIdx = -1;
        let oldestTime = Date.now();
        for (let i = 0; i < connectionPool.length; i++) {
            const conn = connectionPool[i];
            if (conn.state === CONNECTION_STATES.HASH_RECEIVED && conn.registrationData) {
                if (conn.createdAt < oldestTime) {
                    oldestTime = conn.createdAt;
                    oldestIdx = i;
                }
            }
        }
        if (oldestIdx !== -1) {
            chosenConn = connectionPool[oldestIdx];
            connectionPool.splice(oldestIdx, 1);
            console.log(`⚡ Using warm connection from pool (pool size now: ${connectionPool.length}/${MAX_POOL_SIZE})`);
            try {
                console.time('warmActivation');
                await chosenConn.activateWarmConnection();
                console.timeEnd('warmActivation');
                activeConnection = chosenConn;
                Promise.resolve().then(() => {
                    warmConnectionPool().catch(err => {
                        console.error("Error warming connection pool after using connection:", err);
                    });
                });
                return chosenConn;
            } catch (error) {
                console.error("Failed to activate warm connection:", error.message || error);
                chosenConn.cleanup();
            }
        } else {
            console.log("No suitable warm connections in pool");
        }
    } else if (!activateFromPool) {
        console.log("Not using pool for this connection (monitoring mode)");
    }
    
    console.log("Creating new active connection");
    const newConn = createConnection();
    try {
        await newConn.initialize(false);
        activeConnection = newConn;
        return newConn;
    } catch (error) {
        console.error("Failed to create new connection:", error.message || error);
        Promise.resolve().then(() => {
            warmConnectionPool().catch(err => {
                console.error("Error warming connection pool after connection failure:", err);
            });
        });
        throw error;
    }
}

async function getMonitoringConnection() {
    return getConnection(false);
}

async function tryReconnectWithBackoff() {
    reconnectAttempt++;
    const backoffTime = Math.min(RECONNECT_BACKOFF_BASE * Math.pow(1.5, reconnectAttempt - 1), 3000);
    console.log(`⚡ Quick reconnect attempt ${reconnectAttempt} with ${backoffTime}ms backoff...`);
    return new Promise((resolve, reject) => {
        setTimeout(async () => {
            try {
                const conn = await getConnection(true);
                resolve(conn);
            } catch (error) {
                console.error(`Reconnect attempt ${reconnectAttempt} failed:`, error.message || error);
                if (reconnectAttempt < MAX_RECONNECT_ATTEMPTS) {
                    try {
                        const conn = await tryReconnectWithBackoff();
                        resolve(conn);
                    } catch (err) {
                        reject(err);
                    }
                } else {
                    console.error(`Giving up after ${MAX_RECONNECT_ATTEMPTS} reconnect attempts`);
                    reconnectAttempt = 0;
                    reject(new Error("Maximum reconnection attempts reached"));
                }
            }
        }, backoffTime);
    });
}

async function handleRivals(rivals, mode, connection) {
    if (!connection.botId || rivals.length === 0) {
        console.log(`No rivals to handle or bot ID not set`);
        return;
    }
    
    currentMode = mode;
    const waitTime = mode === 'attack' ? currentAttackTime : currentDefenceTime;
    console.log(`Handling rivals in ${mode} mode with wait time: ${waitTime}ms [${connection.botId}]`);
    
    monitoringMode = false;
    
    for (const rival of rivals) {
        const id = userMap[rival];
        if (id) {
            await new Promise(resolve => {
                setTimeout(() => {
                    console.log(`Sending ACTION 3 to ${rival} (ID: ${id}) [${connection.botId}]`);
                    connection.send(`ACTION 3 ${id}`);
                    resolve();
                }, waitTime);
            });
            console.log(`Actions sent to ${rival} (ID: ${id}) with ${waitTime}ms delay [${connection.botId}]`);
        }
    }
    
    console.log(`Reloading WebSocket connection [${connection.botId}]`);
    connection.cleanup();
    if (activeConnection === connection) {
        activeConnection = null;
    }
    
    monitoringMode = true;
    
    console.log("⚡ Actions completed, immediately activating new connection");
    Promise.resolve().then(async () => {
        try {
            console.time('reconnectAfterAction');
            await getConnection(true);
            console.timeEnd('reconnectAfterAction');
        } catch (error) {
            console.error("Failed to get new connection after rival handling:", error.message || error);
            tryReconnectWithBackoff().catch(retryError => {
                console.error("All reconnection attempts failed:", retryError.message || retryError);
            });
        }
    });
}

async function handlePrisonAutomation(connection) {
    if (prisonAutomationInProgress) {
        console.log("Prison automation already in progress, skipping...");
        return;
    }
    
    try {
        prisonAutomationInProgress = true;
        pauseConnectionPoolManagement = true; // Set the flag to pause connection pool management
        console.log(`🔒 Starting prison automation sequence with planetName: ${planetName}`);
        
        console.log("Closing WebSocket connection before starting prison automation");
        connection.cleanup();
        if (activeConnection === connection) {
            activeConnection = null;
        }
        
        // Close all connections in the pool to prevent any interference
        console.log("Closing all connections in the pool during prison automation");
        for (const conn of connectionPool) {
            conn.cleanup();
        }
        connectionPool.length = 0;
        
        await executePrisonAutomation();
        
        console.log("Prison automation completed, restoring WebSocket connection");
        
        Promise.resolve().then(async () => {
            try {
                console.time('reconnectAfterPrisonAutomation');
                await getConnection(true);
                console.timeEnd('reconnectAfterPrisonAutomation');
                prisonAutomationInProgress = false;
                pauseConnectionPoolManagement = false; // Reset the flag when prison automation is complete
            } catch (error) {
                console.error("Failed to get new connection after prison automation:", error.message || error);
                prisonAutomationInProgress = false;
                pauseConnectionPoolManagement = false; // Reset the flag even if there's an error
                tryReconnectWithBackoff().catch(retryError => {
                    console.error("All reconnection attempts failed:", retryError.message || retryError);
                });
            }
        });
    } catch (error) {
        console.error("Error during prison automation:", error);
        prisonAutomationInProgress = false;
        pauseConnectionPoolManagement = false; // Reset the flag in case of any errors
        
        Promise.resolve().then(async () => {
            try {
                await getConnection(true);
            } catch (err) {
                console.error("Failed to restore connection after prison automation error:", err);
                tryReconnectWithBackoff();
            }
        });
    }
}

async function executePrisonAutomation() {
    console.log("Prison automation started...");
    let mainTimeoutId = null; // For the overall automation timeout

    try {
        if (!prisonBrowser || !prisonBrowser.isConnected()) {
            console.log("No active browser session found. Launching headless browser for prison automation...");
            prisonBrowser = await puppeteer.launch({
                headless: false, // Consider making this configurable
                args: ['--no-sandbox', '--disable-setuid-sandbox']
            });
            console.log("New browser instance created");
            prisonPage = null; // Ensure page is recreated if browser is new
        } else {
            console.log("Reusing existing browser instance");
        }

        let isNewPage = false;
        if (!prisonPage || prisonPage.isClosed()) {
            prisonPage = await prisonBrowser.newPage();
            console.log("New page created in browser");
            isNewPage = true;

            // Expose a function from Node.js to the page context.
            // This is the actual function Puppeteer binds. Called only once per new page.
            await prisonPage.exposeFunction('__node_notifyPrisonScriptComplete', (status) => {
                if (currentPrisonScriptResolve) {
                    console.log(`[Node] Received status from browser via bridge: ${status}`);
                    currentPrisonScriptResolve(status);
                    // The promise currentPrisonScriptResolve belongs to will handle making it null effectively
                } else {
                    console.warn("[Node] __node_notifyPrisonScriptComplete called but no current resolver.");
                }
            });

            // Define window.notifyPrisonScriptComplete in the page context.
            // This script runs on new documents in the page (e.g., after navigation).
            // It makes the userscript's call to window.notifyPrisonScriptComplete route to our exposed function.
            await prisonPage.evaluateOnNewDocument(() => {
                window.notifyPrisonScriptComplete = (status) => {
                    // This log is in browser context
                    // console.log('[Browser Context] window.notifyPrisonScriptComplete called with:', status);
                    if (typeof window.__node_notifyPrisonScriptComplete === 'function') {
                        window.__node_notifyPrisonScriptComplete(status);
                    } else {
                        // console.error('[Browser Context] Bridge function __node_notifyPrisonScriptComplete not found.');
                    }
                };
            });
            console.log("Bridging function 'window.notifyPrisonScriptComplete' (via __node_notifyPrisonScriptComplete) set up for new page.");
        } else {
            console.log("Reusing existing page.");
        }

        // This promise will be resolved when __node_notifyPrisonScriptComplete is called
        const scriptCompletionPromise = new Promise(resolve => {
            currentPrisonScriptResolve = resolve;
        });

        // Overall timeout for the entire prison automation sequence
        const overallTimeoutPromise = new Promise((resolve) => {
            mainTimeoutId = setTimeout(() => {
                console.log("Prison automation timed out (60s Node.js-side overall timeout).");
                if (currentPrisonScriptResolve) {
                    currentPrisonScriptResolve('TIMEOUT_NODEJS'); // Signal the scriptCompletionPromise about the timeout
                }
                resolve('TIMEOUT_NODEJS_OVERALL'); // Resolve the timeout promise itself
            }, 60000); // 60 seconds
        });

        // Navigate to the page; this ensures the evaluateOnNewDocument script has run for the target origin.
        await prisonPage.goto('https://galaxy.mobstudio.ru/web/', { waitUntil: 'networkidle2' });

        // Set localStorage for the userscript
        const currentRecoveryCode = config.RC; //
        const currentPlanetName = config.planetName; // updated to use config.planetName consistently

        await prisonPage.evaluate((rc, pn) => {
            localStorage.setItem('PRISON_AUTOMATION_DATA', JSON.stringify({
                recoveryCode: rc,
                planetName: pn
            }));
            // console.log('[Browser Context] PRISON_AUTOMATION_DATA set:', localStorage.getItem('PRISON_AUTOMATION_DATA'));
        }, currentRecoveryCode, currentPlanetName); //
		
        console.log(`Injecting prison automation script with planet name: ${currentPlanetName}`); //
        const userScriptContent = fsSync.readFileSync('./prison.user_1.js', 'utf8'); // Use sync version for simplicity here or await fs.readFile
        
        await prisonPage.evaluate((scriptContent) => {
            // Remove old script tag if it exists to ensure fresh execution
            const oldScript = document.getElementById('galaxyAutomationUserScript');
            if (oldScript) {
                oldScript.remove();
            }
            const scriptElement = document.createElement('script');
            scriptElement.id = 'galaxyAutomationUserScript'; // Add an ID for easy removal
            scriptElement.textContent = scriptContent;
            document.head.appendChild(scriptElement);
            // console.log("[Browser Context] Prison userscript (re)-injected.");
        }, userScriptContent); //

        // Wait for either the script to complete/error out, or for the overall timeout
        const result = await Promise.race([
            scriptCompletionPromise,
            overallTimeoutPromise
        ]);

        clearTimeout(mainTimeoutId); // Important: clear the timeout if scriptCompletionPromise resolved first

        console.log(`Prison automation sequence finished with result: ${result}`);

        if (result === 'TIMEOUT_NODEJS_OVERALL' || result === 'TIMEOUT_NODEJS') {
            console.warn("Prison automation resulted in a timeout.");
            // Optionally throw an error to indicate timeout failure upstream
            // throw new Error("Prison automation timed out");
        } else if (typeof result === 'string' && result.startsWith('ERROR')) {
            console.error(`Prison automation reported an error: ${result}`);
            // Optionally throw an error
            // throw new Error(`Prison automation failed: ${result}`);
        }

    } catch (error) {
        console.error("Critical error during Puppeteer prison automation steps:", error);
        if (mainTimeoutId) {
            clearTimeout(mainTimeoutId); // Ensure timeout is cleared on any error
        }
        // If an error occurs, ensure currentPrisonScriptResolve is cleared if it's still pending,
        // though Promise.race should handle this if scriptCompletionPromise is part of it.
        if (currentPrisonScriptResolve && (typeof scriptCompletionPromise !== 'undefined' && scriptCompletionPromise.isPending && scriptCompletionPromise.isPending())) { // Requires a promise extension to check isPending, or restructure
             currentPrisonScriptResolve('ERROR_NODEJS_CRITICAL');
        }
        throw error; // Re-throw to be handled by the caller
    } finally {
        currentPrisonScriptResolve = null; // Always clear the resolver for the next run
    }
    // Note: Browser and page are intentionally not closed here to allow reuse
}

warmConnectionPool().catch(err => {
    console.error("Error during initial connection pool warm-up:", err);
});

function cleanupPrisonBrowser() {
    if (prisonBrowser) {
        try {
            console.log("Closing prison automation browser...");
            prisonBrowser.close();
            prisonBrowser = null;
            prisonPage = null;
        } catch (err) {
            console.error("Error closing prison browser:", err);
        }
    }
}

setInterval(() => {
    if (!poolWarmupInProgress) {
        warmConnectionPool().catch(err => {
            console.error("Error warming connection pool:", err);
        });
    }
}, 20000);

async function recoverUser(password) {
    console.log("Starting recovery with code:", password);
    await warmConnectionPool().catch(err => {
        console.error("Initial pool warm-up failed:", err.message || err);
    });
    try {
        await getMonitoringConnection();
        console.log("Initial monitoring connection established successfully");
    } catch (error) {
        console.error("Failed to establish initial monitoring connection:", error.message || error);
        setTimeout(() => {
            recoverUser(password);
        }, 1000);
    }
}

async function maintainMonitoringConnection() {
    if (pauseConnectionPoolManagement) {
        console.log("Monitoring connection maintenance skipped due to prison automation");
        return;
    }

    if (monitoringMode && (!activeConnection || activeConnection.state !== CONNECTION_STATES.READY)) {
        console.log("Maintaining monitoring connection...");
        try {
            await getMonitoringConnection();
        } catch (error) {
            console.error("Failed to maintain monitoring connection:", error.message || error);
            setTimeout(() => {
                maintainMonitoringConnection();
            }, 5000);
        }
    }
}

setInterval(() => {
    maintainMonitoringConnection();
}, 30000);

recoverUser(recoveryCode);

process.on('SIGINT', () => {
    console.log("Shutting down...");
    connectionPool.forEach(conn => {
        conn.cleanup();
    });
    if (activeConnection) {
        activeConnection.cleanup();
    }
	cleanupPrisonBrowser();
    process.exit(0);
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught exception:', error.message || error);
    if (activeConnection) {
        activeConnection.cleanup();
        activeConnection = null;
    }
    setTimeout(() => {
        if (monitoringMode) {
            getMonitoringConnection().catch(err => {
                console.error("Failed to get new monitoring connection after uncaught exception:", err.message || err);
            });
        } else {
            getConnection(true).catch(err => {
                console.error("Failed to get new connection after uncaught exception:", err.message || err);
            });
        }
    }, 1000);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    if (activeConnection) {
        activeConnection.cleanup();
        activeConnection = null;
    }
    setTimeout(() => {
        if (monitoringMode) {
            getMonitoringConnection().catch(err => {
                console.error("Failed to get new monitoring connection after unhandled rejection:", err.message || err);
            });
        } else {
            getConnection(true).catch(err => {
                console.error("Failed to get new connection after unhandled rejection:", err.message || err);
            });
        }
    }, 1000);
});