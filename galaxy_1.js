const puppeteer = require('puppeteer');
const WebSocket = require('ws');
const fs = require('fs').promises;
const fsSync = require('fs');
const CryptoJS = require('crypto-js');

// Configuration
let prisonAutomationInProgress = false;
let config;
let rivalNames = [];
let recoveryCode;
let userMap = {}; // Map of user names to IDs
let reconnectAttempt = 0;

// Connection pool settings
const MAX_POOL_SIZE = 20; // Increased from 5 to 20 as requested
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BACKOFF_BASE = 100; // Start with 100ms backoff
const connectionPool = [];
let activeConnection = null;
let poolWarmupInProgress = false;

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
let monitoringMode = true; // Flag to indicate if the bot should stay connected and monitor

function updateConfigValues() {
    try {
        delete require.cache[require.resolve('./config1.json')];
        config = require('./config1.json');
        rivalNames = Array.isArray(config.rival) ? config.rival : config.rival.split(',').map(name => name.trim());
        recoveryCode = config.RC;
        
        // Reset timing values to their initial state
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

// Initial config load
updateConfigValues();

// Watch config file for changes
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
            if (prisonAutomationInProgress) {
                console.log(`Prison automation in progress, deferring connection.initialize() for ${this.botId || 'new connection'}.`);
                return Promise.reject(new Error("Prison automation in progress")); // Reject to prevent further processing
            }
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
                        handshakeTimeout: 3000 // Reduced timeout
                    });
                    
                    this.connectionTimeout = setTimeout(() => {
                        console.log("Connection initialization timeout");
                        this.authenticating = false;
                        this.cleanup();
                        reject(new Error("Connection initialization timeout"));
                    }, 5000); // Reduced to 5 seconds
                    
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
                        parse353(payload, this);
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

// Parse 353 command (user list)
async function parse353(payload, connection) {
    console.log(`Parsing 353 payload [${connection.botId}]: ${payload}`);

    if (payload.includes('Prison')) {
        console.log(`"Prison" keyword detected in 353 payload [${connection.botId}]`);
        
        if (prisonAutomationInProgress) {
            console.log(`Prison automation already in progress, skipping new trigger [${connection.botId}]`);
            return;
        }

        prisonAutomationInProgress = true;
        console.log(`Set prisonAutomationInProgress = true [${connection.botId}]`);

        if (connection && typeof connection.send === 'function') {
            connection.send('QUIT :ds');
            console.log(`Sent QUIT :ds via connection [${connection.botId}]`);
        }

        try {
            console.log(`Starting prison automation from parse353 [${connection.botId}]...`);
            const automationResult = await runPrisonAutomation();
            console.log(`Prison automation result [${connection.botId}]:`, automationResult);
        } catch (error) {
            console.error(`Error during runPrisonAutomation call from parse353 [${connection.botId}]:`, error);
        } finally {
            console.log(`Setting prisonAutomationInProgress = false [${connection.botId}]`);
            prisonAutomationInProgress = false;
            // Attempt to reconnect after automation is done or failed
            console.log(`Attempting to reconnect after prison automation [${connection.botId}]...`);
            getConnection(true).catch(err => console.error(`Failed to reconnect after prison automation [${connection.botId}]:`, err));
        }
        return; // Return early to prevent normal rival detection logic
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

// Handle JOIN command
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
    if (poolWarmupInProgress) {
        console.log("Pool warmup already in progress, skipping");
        return;
    }
    
    try {
        poolWarmupInProgress = true;
        console.log(`Warming connection pool (current size: ${connectionPool.length}/${MAX_POOL_SIZE})`);
        
        const now = Date.now();
        const STALE_THRESHOLD = 5 * 60 * 1000; // 5 minutes
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
    if (prisonAutomationInProgress) {
        console.log('Prison automation in progress, deferring getConnection.');
        // It's important to return a promise that perhaps never resolves or rejects,
        // or rejects with a specific "automation in progress" error,
        // to prevent downstream logic from proceeding as if a connection was obtained.
        // For now, let's return a promise that won't resolve, to halt dependent operations.
        return new Promise(() => {}); 
    }
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
    if (prisonAutomationInProgress) {
        console.log('Prison automation in progress, deferring tryReconnectWithBackoff.');
        return Promise.resolve(); // Return a resolved promise to not break promise chains
    }
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

warmConnectionPool().catch(err => {
    console.error("Error during initial connection pool warm-up:", err);
});

setInterval(() => {
    if (!poolWarmupInProgress) {
        warmConnectionPool().catch(err => {
            console.error("Error warming connection pool:", err);
        });
    }
}, 20000);

function updateTimingValue(type) {
    if (type === 'attack') {
        currentAttackTime += config.attackIntervalTime;
        if (currentAttackTime > config.stopAttackTime) {
            currentAttackTime = config.startAttackTime;
        }
        console.log(`Updated attack time to: ${currentAttackTime}ms`);
        return currentAttackTime;
    } else {
        currentDefenceTime += config.defenceIntervalTime;
        if (currentDefenceTime > config.stopDefenceTime) {
            currentDefenceTime = config.startDefenceTime;
        }
        console.log(`Updated defence time to: ${currentDefenceTime}ms`);
        return currentDefenceTime;
    }
}

async function handleRivals(rivals, mode, connection) {
    if (prisonAutomationInProgress) {
        console.log(`Prison automation in progress, deferring handleRivals for ${rivals.join(', ')} in ${mode} mode.`);
        return;
    }
    if (!connection.botId || rivals.length === 0) {
        console.log(`No rivals to handle or bot ID not set`);
        return;
    }
    
    const waitTime = mode === 'attack' ? currentAttackTime : currentDefenceTime;
    console.log(`Handling rivals in ${mode} mode with wait time: ${waitTime}ms [${connection.botId}]`);
    
    monitoringMode = false;
    
    for (const rival of rivals) {
        const id = userMap[rival];
        if (id) {
            await new Promise(resolve => {
                setTimeout(() => {
                    connection.send(`ACTION 3 ${id}`);
                    resolve();
                }, waitTime);
            });
            console.log(`Completed actions on ${rival} (ID: ${id}) with ${waitTime}ms delay [${connection.botId}]`);
        }
    }
    
    updateTimingValue(mode);
    connection.send(`QUIT :ds`);
    monitoringMode = true;
    
    if (activeConnection === connection) {
        activeConnection = null;
    }
    
    console.log("⚡ Actions completed, immediately activating warm connection");
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

async function recoverUser(password) {
    console.log("Starting recovery with code:", password);

    // Removed call to runPrisonAutomation() from here as it's now triggered by parse353

    await warmConnectionPool().catch(err => {
        console.error("Initial pool warm-up failed:", err.message || err);
    });
    
    // Proceed with normal IRC connection logic
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
    if (prisonAutomationInProgress) {
        console.log('Prison automation in progress, deferring maintainMonitoringConnection.');
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

async function runPrisonAutomation() {
    let browser;
    console.log('Starting prison automation...');
    try {
        browser = await puppeteer.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage', // Common in Docker/CI
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu' // Often necessary in headless
            ],
            dumpio: process.env.DEBUG === 'true' // Pipe browser I/O to process for debugging
        });
        const page = await browser.newPage();

        console.log('Navigating to https://galaxy.mobstudio.ru/web/');
        await page.goto('https://galaxy.mobstudio.ru/web/', { waitUntil: 'networkidle0', timeout: 60000 });
        
        let onPrisonScriptDoneCallback;
        const prisonScriptPromise = new Promise(resolve => {
            onPrisonScriptDoneCallback = (status) => {
                console.log(`onPrisonScriptDone called with status: ${status}`);
                resolve(status); // Resolve with the status directly
            };
        });

        await page.exposeFunction('onPrisonScriptDone', onPrisonScriptDoneCallback);

        const prisonScriptContent = await fs.readFile('prison.user_1.js', 'utf8');
        console.log('Successfully read prison.user_1.js');
        
        await page.evaluate(prisonScriptContent);
        console.log('Prison script injected and evaluated.');
        
        const timeoutPromise = new Promise((resolve) => {
            const fiveMinutes = 5 * 60 * 1000;
            setTimeout(() => resolve({ status: 'TIMEOUT', message: 'Prison automation timed out after 5 minutes.' }), fiveMinutes);
        });

        console.log('Waiting for prison script to complete or timeout...');
        const result = await Promise.race([prisonScriptPromise, timeoutPromise]);
        
        if (typeof result === 'string') {
            console.log(`Prison automation finished with result: ${result}`);
            return result; 
        } else if (result && typeof result.status !== 'undefined') {
            console.log(`Prison automation finished with status: ${result.status}, message: ${result.message || 'N/A'}`);
            return result; 
        } else {
            console.warn(`Prison automation finished with unexpected result type: ${JSON.stringify(result)}`);
            return { status: 'UNKNOWN_RESULT', message: 'The script finished with an unknown result type.'};
        }

    } catch (error) {
        console.error('Error during prison automation:', error); // More generic error message here
        return { status: 'ERROR', message: error.message };
    } finally {
        if (browser) {
            try {
                console.log('Closing browser (after launch/navigation attempt)...');
                await browser.close();
            } catch (closeError) {
                console.error('Error closing browser:', closeError);
            }
        }
        console.log('Prison automation attempt (launch/navigation) finished.');
    }
}