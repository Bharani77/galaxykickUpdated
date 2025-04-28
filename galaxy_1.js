const puppeteer = require('puppeteer');
const fs = require('fs').promises;
const fsSync = require('fs');  // For file watching
const path = require('path');
const { Buffer } = require('buffer'); // Needed for potential Base64 decoding

/**
 * GalaxyAutomation - Core class for managing the Galaxy game automation
 */
class GalaxyAutomation {
    constructor() {
        // Core components
        this.browser = null;
        this.page = null;
        this.cdpClient = null;
        
        // State flags
        this.stopMonitoring = false;
        this.isTampermonkeyRunning = false;
        this.isPrisonMode = false;
        
        // Configuration
        this.config = null;
        this.rivalNames = [];
        this.planetName = "";
        this.recoveryCode = "";
        this.timingParams = {
            startAttack: 0,
            startIntervalAttack: 100,
            stopAttack: 5000,
            startDefence: 0,
            startDefenceInterval: 100,
            stopDefence: 5000
        };
        
        // Regex patterns
        this.joinRegexes = [];
        this.listRegexes = [];
        this.prisonRegex = /\bPRISON\b/i;
        this.joinPrisonRegex = /JOIN\s*.+?Prison/i;
        this.listPrisonRegex = /353\s*.+?Prison/i;
        
        // Script paths
        this.scriptPath = path.join(__dirname, 'login.user_1.js');
        this.prisonScriptPath = path.join(__dirname, 'prison.user_1.js');
        this.targetUrl = 'https://galaxy.mobstudio.ru/web/';
        this.postLoginSelector = '.mdc-button > .mdc-top-app-bar__title';
        
        // Retry counters and timeouts
        this.retryCount = 0;
        this.maxRetries = 5;
        this.restartDelay = 5000;
        
        // Load initial configuration
        this.loadConfiguration();
    }

    /**
     * Helper to escape regex special characters
     */
    escapeRegex(str) {
        if (!str) return '';
        return str.replace(/[.*+?^${}()|[\]\\`]/g, '\\$&');
    }

    /**
     * Load configuration from file
     */
    loadConfiguration() {
        try {
            // Clear require cache to get fresh config
            delete require.cache[require.resolve('./config1.json')];
            this.config = require('./config1.json');
            
            // Process rival names
            const rivalNamesArg = Array.isArray(this.config.rival) ? 
                this.config.rival.join(',') : this.config.rival;
            this.rivalNames = rivalNamesArg.split(',').map(name => name.trim());
            
            // Set other configuration values
            this.planetName = this.config.planetName || "";
            this.recoveryCode = this.config.RC;
            
            // Update timing parameters
            this.timingParams.startAttack = this.config.startAttackTime || 0;
            this.timingParams.startIntervalAttack = this.config.attackIntervalTime || 100;
            this.timingParams.stopAttack = this.config.stopAttackTime || 5000;
            this.timingParams.startDefence = this.config.startDefenceTime || 0;
            this.timingParams.startDefenceInterval = this.config.defenceIntervalTime || 100;
            this.timingParams.stopDefence = this.config.stopDefenceTime || 5000;
            
            // Rebuild regex patterns for the updated rival names
            this.buildRegexPatterns();
            
            console.log("=== Galaxy Auto-Attacker Configuration ===");
            console.log(`Target URL: ${this.targetUrl}`);
            console.log(`Rival Names: ${this.rivalNames.join(', ')}`);
            console.log(`Planet Name: ${this.planetName}`);
            console.log("Timing Parameters:", this.timingParams);
            console.log("=======================================");
            
            return {
                newAttackDelay: this.timingParams.startAttack,
                newDefenceDelay: this.timingParams.startDefence
            };
        } catch (error) {
            console.error("Error loading configuration:", error);
            return null;
        }
    }

    /**
     * Build regex patterns for rival detection
     */
    buildRegexPatterns() {
        // Clear existing patterns
        this.joinRegexes = [];
        this.listRegexes = [];
        
        // Rebuild patterns for each rival name
        this.rivalNames.forEach((rivalName) => {
            const escapedRivalName = this.escapeRegex(rivalName);
            console.log(`[Setup] Created escaped regex for '${rivalName}': ${escapedRivalName}`);
            
            this.joinRegexes.push(new RegExp(`JOIN\\s+[-\\s\\w]*${escapedRivalName}\\s+\\d+`, 'i')); 
            this.listRegexes.push(new RegExp(`353\\s+\\d+.*?@?${escapedRivalName}\\s+\\d+`, 'i'));
            this.joinRegexes.push(new RegExp(`JOIN.*?${escapedRivalName}`, 'i'));
            this.listRegexes.push(new RegExp(`353.*?${escapedRivalName}`, 'i'));
        });
        
        console.log("[Debug] JOIN regex patterns:");
        this.joinRegexes.forEach((regex, i) => console.log(`  [${i}]: ${regex}`));
    }

    /**
     * Setup configuration file watcher
     */
    setupConfigWatcher() {
        fsSync.watch('config1.json', async (eventType, filename) => {
            if (eventType === 'change') {
                console.log('Config file changed, updating values...');
                
                // First update the local config values and get new delays
                const newDelays = this.loadConfiguration();
                
                if (newDelays && this.page && !this.page.isClosed()) {
                    try {
                        // Update all values in the browser context
                        await this.updateGMValues();
                        
                        // Additional step: Force refresh of WebSocket monitoring
                        if (this.cdpClient) {
                            console.log("Config changed significantly, restarting WebSocket monitoring...");
                            // Detach current client
                            await this.detachCDPClient();
                            
                            // Setup a new one with fresh config
                            await this.setupWebSocketListener();
                        }
                        
                        console.log('Successfully applied all configuration changes');
                    } catch (error) {
                        console.error("Error handling config change:", error);
                    }
                }
            }
        });
    }

    /**
     * Safely detach CDP client
     */
    async detachCDPClient() {
        if (this.cdpClient) {
            try {
                await this.cdpClient.removeAllListeners();
                await this.cdpClient.detach();
                console.log("CDP client detached successfully");
            } catch (e) {
                console.warn("Warning: Error detaching CDP client:", e.message);
            }
            this.cdpClient = null;
        }
    }

    /**
     * Update GM values in the browser context
     */
    async updateGMValues() {
    if (!this.page || this.page.isClosed()) return;
    
    try {
        // Get the latest rivals as a comma-separated string
        const currentRivalNames = Array.isArray(this.config.rival) ? this.config.rival.join(',') : this.config.rival;
        const currentPlanetName = this.config.planetName;
        
        // First, retrieve the current delay values to preserve them
        const currentAttackDelay = await this.page.evaluate(async () => {
            return await window.GM_getValue('CURRENT_ATTACK_DELAY', null);
        });
        
        const currentDefenceDelay = await this.page.evaluate(async () => {
            return await window.GM_getValue('CURRENT_DEFENCE_DELAY', null);
        });
        
        await this.page.evaluate(async (names, planet, params, attackDelay, defenceDelay) => {
            if (typeof window.GM_setValue !== 'function') {
                console.error('[Browser] GM_setValue function not found!');
                return;
            }
            
            await window.GM_setValue('RIVAL_NAMES', names);
            await window.GM_setValue('PLANET_NAME', planet);
            await window.GM_setValue('TIMING_PARAMS', JSON.stringify(params));
            
            // Only reset the delay values if they're null or undefined
            // This preserves the current incremented values between reloads
            if (attackDelay === null || attackDelay === undefined) {
                await window.GM_setValue('CURRENT_ATTACK_DELAY', params.startAttack);
            }
            
            if (defenceDelay === null || defenceDelay === undefined) {
                await window.GM_setValue('CURRENT_DEFENCE_DELAY', params.startDefence);
            }
            
            console.log('[Browser] Configuration fully updated via GM_setValue with values:', 
                { names, planet, params, 
                  currentAttackDelay: attackDelay || params.startAttack, 
                  currentDefenceDelay: defenceDelay || params.startDefence });
        }, currentRivalNames, currentPlanetName, this.timingParams, currentAttackDelay, currentDefenceDelay);
        
        console.log("Successfully updated all GM values in browser context");
    } catch (error) {
        console.error("Error updating GM values:", error);
        throw error; // Re-throw for higher-level error handling
    }
}

    /**
     * Launch and configure the browser
     */
    async launchBrowser() {
        console.log('Launching browser...');
        this.browser = await puppeteer.launch({
            headless: false,
            args: [
                '--start-maximized',
                '--disable-infobars',
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-web-security',
                '--disable-features=IsolateOrigins,site-per-process',
                '--disable-csp'
            ],
        });
        console.log('Browser launched successfully');
    }

    /**
     * Setup the page with event handlers and expose functions
     */
    async setupPage() {
        if (!this.browser) throw new Error("Browser not initialized");
        
        this.page = await this.browser.newPage();
        console.log('New page created.');

        // --- Console/Error Logging from Browser ---
        this.page.on('console', msg => {
            const type = msg.type().toUpperCase();
            const text = msg.text();
            console.log(`[BROWSER ${type}] ${text}`);
        });
        
        this.page.on('pageerror', error => 
            console.error(`[BROWSER PAGEERROR] ${error.message}\n${error.stack}`));
            
        this.page.on('requestfailed', request => 
            console.warn(`[BROWSER REQFAIL] ${request.method()} ${request.url()} ${request.failure()?.errorText}`));
            
        this.page.on('close', () => {
            console.log('[Puppeteer] Page closed event detected.');
            this.stopMonitoring = true;
            this.detachCDPClient().catch(e => 
                console.error("Error detaching CDP on close:", e));
        });

        await this.page.setViewport({ width: 1366, height: 768 });
        console.log('Viewport set.');

        // --- Storage Simulation & Tampermonkey Communication ---
        console.log('Exposing functions for Tampermonkey...');
        const storage = {};
        
        await this.page.exposeFunction('GM_getValue_puppeteer', async (k, d) => storage[k] ?? d);
        
        await this.page.exposeFunction('GM_setValue_puppeteer', (k, v) => {
            storage[k] = v;
            return v;
        });
        
        await this.page.exposeFunction('notifyPrisonScriptComplete', async (status) => {
            if (this.stopMonitoring) return;
            console.log(`[Puppeteer] Prison unlock script completed. Status: ${status}`);
            this.isPrisonMode = false;
            await this.restartMonitoring(null); // No payloadData available here
        });
        
        await this.page.exposeFunction('notifyPuppeteerComplete', async (status) => {
            if (this.stopMonitoring) return;
            console.log(`[Puppeteer] Tampermonkey signaled completion. Status: ${status}`);
            this.isTampermonkeyRunning = false;
            await this.restartMonitoring(null); // No payloadData available here
        });
        
        await this.page.exposeFunction('reportTampermonkeyError', (errorMessage) => {
            console.error(`[Tampermonkey ERROR REPORT] ${errorMessage}`);
        });
        
        console.log('Functions exposed successfully.');
    }

    /**
     * Inject user scripts into the page
     */
    async injectScripts() {
        try {
            console.log(`Injecting Tampermonkey script: ${this.scriptPath}`);
            const userScript = await fs.readFile(this.scriptPath, 'utf8');
            
            console.log(`Loading prison unlock script: ${this.prisonScriptPath}`);
            const prisonScript = await fs.readFile(this.prisonScriptPath, 'utf8');
            
            await this.page.evaluateOnNewDocument((userScriptContent, prisonScriptContent) => {
                console.log('[Browser] Setting up GM environment in evaluateOnNewDocument...');
                
                // Setup GM environment
                window.GM_getValue = (key, defaultValue) => {
                    console.log(`[Browser GM] Getting value for key: ${key}`);
                    if (typeof window.GM_getValue_puppeteer === 'function') {
                        return window.GM_getValue_puppeteer(key, defaultValue);
                    }
                    console.warn(`[Browser GM] GM_getValue_puppeteer not available yet for key: ${key}`);
                    return defaultValue;
                };
                
                window.GM_setValue = (key, value) => {
                    console.log(`[Browser GM] Setting value for key: ${key}`);
                    if (typeof window.GM_setValue_puppeteer === 'function') {
                        return window.GM_setValue_puppeteer(key, value);
                    }
                    console.warn(`[Browser GM] GM_setValue_puppeteer not available yet for key: ${key}`);
                    return value;
                };
                
                window.unsafeWindow = window;
                window.GM_addStyle = (css) => { 
                    let style = document.createElement('style'); 
                    style.textContent = css; 
                    document.head.append(style); 
                };
                window.GM_xmlhttpRequest = () => console.warn('GM_xmlhttpRequest not implemented');
                window.GM_registerMenuCommand = () => console.warn('GM_registerMenuCommand not implemented');
                window.GM_log = console.log;
                
                // Store scripts for execution after page load
                window.prisonScriptContent = prisonScriptContent;
                window.userScriptContent = userScriptContent;
                
                // Setup execution functions
                window.executeUserScript = function() {
                    console.log('[Browser] Executing main user script...');
                    try {
                        new Function(window.userScriptContent)();
                        console.log('[Browser] Main user script executed successfully');
                    } catch (e) {
                        console.error('[Browser] Error executing main user script:', e);
                    }
                };
                
                window.executePrisonScript = function() {
                    try {
                        console.log('[Browser] Executing prison unlock script...');
                        new Function(window.prisonScriptContent)();
                        window.prisonTimeoutId = setTimeout(() => {
                            if (typeof window.notifyPrisonScriptComplete === 'function') {
                                console.log('[Browser] Prison script timeout - forcing completion signal');
                                window.notifyPrisonScriptComplete('TIMEOUT_COMPLETED');
                            }
                        }, 20000);
                    } catch (e) {
                        console.error('[Browser] Error executing Prison script:', e);
                        if (typeof window.notifyPrisonScriptComplete === 'function') {
                            window.notifyPrisonScriptComplete('ERROR');
                        }
                    }
                };
                
                // Auto-execute the main user script after DOM is loaded
                document.addEventListener('DOMContentLoaded', () => {
                    console.log('[Browser] DOMContentLoaded event fired, executing user script...');
                    window.executeUserScript();
                });
                
                console.log('[Browser] evaluateOnNewDocument setup complete');
            }, userScript, prisonScript);
            
            console.log('Scripts injected successfully');
        } catch (error) {
            console.error('Error injecting scripts:', error);
            throw error;
        }
    }

    /**
     * Login to the game
     */
    async login() {
        try {
            console.log('Navigating to target site...');
            await this.page.goto(this.targetUrl, { waitUntil: 'networkidle0', timeout: 60000 });
            
            // Verify script execution in browser
            console.log('After navigation, verifying script execution...');
            await this.page.evaluate(() => {
                console.log('[Browser] In page.evaluate verification');
                console.log('[Browser] tampermonkeyReady =', window.tampermonkeyReady);
                console.log('[Browser] executeTampermonkeyLogic exists =', typeof window.executeTampermonkeyLogic === 'function');
            });
            
            try {
                await this.page.evaluate((script) => {
                    new Function(script)();
                }, await fs.readFile(this.scriptPath, 'utf8'));
                console.log('[Browser] UserScript evaluated successfully.');
            } catch (e) {
                console.error('[Browser] Error executing UserScript:', e.message, e.stack);
            }
            
            console.log('Navigation complete.');
            await this.delay(3000);
            
            // Click recovery code login button
            await this.page.click('.mdc-button--black-secondary > .mdc-button__label', { visible: true });
            
            // Enter recovery code
            await this.page.click('input[name="recoveryCode"]', { visible: true });
            await this.page.type('input[name="recoveryCode"]', this.recoveryCode, { delay: 50 });
            
            // Complete login
            console.log('Waiting for final login button...');
            await this.page.click('.mdc-dialog__button:nth-child(2)');
            console.log('Login navigation likely complete.');
            
            await this.delay(550);
            
            // Debug information
            console.log('Page title:', await this.page.title());
            console.log('Scripts on page:', await this.page.evaluate(() => {
                return Array.from(document.querySelectorAll('script')).map(s => s.src || 'inline');
            }));
            
            // Ensure tampermonkeyReady state
            await this.page.evaluate(() => {
                console.log("[Debug] Window properties:", Object.keys(window));
                console.log("[Debug] tampermonkeyReady value:", window.tampermonkeyReady);
                // Force setting ready status for testing
                window.tampermonkeyReady = window.tampermonkeyReady || true;
            });
            
            // Wait for Tampermonkey script to be ready
            await this.page.waitForFunction(() => {
                return window.tampermonkeyReady === true || 
                       window.tampermonkeyReady === 'error';
            }, { timeout: 45000 });
            
            const readyState = await this.page.evaluate(() => window.tampermonkeyReady);
            if (readyState !== true) {
                throw new Error(`Tampermonkey script failed to initialize: ${readyState}`);
            }
            
            console.log("Login completed successfully");
        } catch (error) {
            console.error('Error during login process:', error);
            throw error;
        }
    }
    
    /**
     * Initialize browser context with configuration values
     */
    async initBrowserContext() {
    try {
        console.log('Storing configuration for Tampermonkey...');
        
        // Create a comma-separated string of rival names
        const rivalNamesString = this.rivalNames.join(',');
        
        await this.page.evaluate(async (names, planet, params) => {
            await window.GM_setValue('RIVAL_NAMES', names);
            await window.GM_setValue('PLANET_NAME', planet);
            await window.GM_setValue('TIMING_PARAMS', JSON.stringify(params));
            
            // Only set initial values if they don't already exist
            const currentAttackDelay = await window.GM_getValue('CURRENT_ATTACK_DELAY', null);
            if (currentAttackDelay === null) {
                await window.GM_setValue('CURRENT_ATTACK_DELAY', params.startAttack);
            }
            
            const currentDefenceDelay = await window.GM_getValue('CURRENT_DEFENCE_DELAY', null);
            if (currentDefenceDelay === null) {
                await window.GM_setValue('CURRENT_DEFENCE_DELAY', params.startDefence);
            }
            
            console.log('[Browser] Configuration stored via GM_setValue.');
        }, rivalNamesString, this.planetName, this.timingParams);
        
        console.log('Configuration stored in browser context.');
    } catch (error) {
        console.error('Error initializing browser context:', error);
        throw error;
    }
}

    /**
     * Setup WebSocket listener using CDP
     */
    async setupWebSocketListener() {
        if (this.stopMonitoring || !this.page || this.page.isClosed()) {
            console.log("[Puppeteer] Skipping WebSocket listener setup (stop signal or page closed).");
            return;
        }

        // Clean up existing CDP client if needed
        await this.detachCDPClient();

        try {
            console.log('[Puppeteer] Setting up WebSocket listener...');
            this.isTampermonkeyRunning = false;
            this.isPrisonMode = false;

            this.cdpClient = await this.page.target().createCDPSession();
            await this.cdpClient.send('Network.enable');
            console.log('[Puppeteer] CDP Network domain enabled.');

            // Handler for WebSocket frames
            const webSocketFrameReceivedListener = async ({ requestId, timestamp, response }) => {
                await this.handleWebSocketMessage(response);
            };
            
            this.cdpClient.on('Network.webSocketFrameReceived', webSocketFrameReceivedListener);

            this.cdpClient.on('error', (error) => {
                console.error('[Puppeteer] CDP Error:', error);
            });
            
            this.cdpClient.on('sessiondetached', () => {
                console.warn('[Puppeteer] CDP session detached.');
                this.cdpClient = null;
                if (!this.stopMonitoring) {
                    console.log('[Puppeteer] Attempting to restart monitoring after CDP detachment...');
                    setTimeout(() => this.restartMonitoring(null), 5000);
                }
            });

            console.log('[Puppeteer] WebSocket listener is active.');

        } catch (cdpError) {
            console.error(`[Puppeteer] Failed to setup WebSocket listener: ${cdpError}`);
            if (!this.stopMonitoring) {
                console.log('[Puppeteer] Retrying listener setup after error...');
                setTimeout(() => this.restartMonitoring(null), 10000);
            }
        }
    }

    /**
     * Handle WebSocket message processing
     */
    async handleWebSocketMessage(response) {
        if (this.stopMonitoring || this.isTampermonkeyRunning || this.isPrisonMode || 
            !this.page || this.page.isClosed() || response.opcode !== 1) {
            return;
        }
        
        const payloadData = response.payloadData;
        console.log(`[Puppeteer WS Received] Payload: ${payloadData.substring(0, 200)}...`);
        
        try {
            // Run message processing tasks in parallel
            await Promise.all([
                this.detectPrisonAndAct(payloadData),
                this.detectRivalsAndAct(payloadData),
                this.checkCurrentPlanetAndAct(payloadData)
            ]);
        } catch (processError) {
            console.warn(`[Puppeteer] Error processing WebSocket message: ${processError.message}. Payload: ${payloadData.substring(0, 100)}...`);
        }
    }

    /**
     * Detect prison in WebSocket messages and trigger prison script
     */
    async detectPrisonAndAct(payloadData) {
        if (this.joinPrisonRegex.test(payloadData) || this.listPrisonRegex.test(payloadData) || this.prisonRegex.test(payloadData)) {
            console.log('[Puppeteer] Prison detected in WebSocket message. Triggering prison unlock script.');
            this.isPrisonMode = true;
            
            try {
                await this.page.evaluate(() => {
                    if (typeof window.executePrisonScript === 'function') {
                        console.log('[Browser] Executing prison unlock script');
                        window.executePrisonScript();
                        window.prisonTimeoutId = setTimeout(() => {
                            if (typeof window.notifyPrisonScriptComplete === 'function') {
                                console.log('[Browser] Prison script timeout - forcing completion signal');
                                window.notifyPrisonScriptComplete('TIMEOUT_COMPLETED');
                            }
                        }, 20000);
                    } else {
                        console.error('[Browser] Error: executePrisonScript function not defined!');
                        if (typeof window.reportTampermonkeyError === 'function') {
                            window.reportTampermonkeyError('executePrisonScript function not found');
                        }
                    }
                });
            } catch (evalError) {
                console.error(`[Puppeteer] Error during page.evaluate for prison script: ${evalError}`);
                this.isPrisonMode = false;
            }
        }
    }

    /**
     * Detect rival names in WebSocket messages and trigger Tampermonkey script
     */
    async detectRivalsAndAct(payloadData) {
        // Debug log current rival names array before checking
        console.log(`[Debug] Current rival names being checked: ${this.rivalNames.join(', ')}`);
        console.log(`[Debug] Current joinRegexes length: ${this.joinRegexes.length}`);
        
        let messageType = null;
        let detectedRivalName = null;
        
        // Check each rival name against the patterns
        for (let i = 0; i < this.rivalNames.length; i++) {
            const rivalName = this.rivalNames[i];
            
            // Ensure we don't exceed array bounds by checking
            const joinIndexExact = i < this.joinRegexes.length ? i : -1;
            const joinIndexFallback = i + this.rivalNames.length < this.joinRegexes.length ? i + this.rivalNames.length : -1;
            
            const joinMatchExact = joinIndexExact >= 0 ? this.joinRegexes[joinIndexExact].test(payloadData) : false;
            const joinFallbackMatch = joinIndexFallback >= 0 ? this.joinRegexes[joinIndexFallback].test(payloadData) : false;
            
            const listIndexExact = i < this.listRegexes.length ? i : -1;
            const listIndexFallback = i + this.rivalNames.length < this.listRegexes.length ? i + this.rivalNames.length : -1;
            
            const listMatchExact = listIndexExact >= 0 ? this.listRegexes[listIndexExact].test(payloadData) : false;
            const listFallbackMatch = listIndexFallback >= 0 ? this.listRegexes[listIndexFallback].test(payloadData) : false;
            
            console.log(`[Debug] Testing rival '${rivalName}' against: ${payloadData.substring(0, 50)}...`);
            console.log(`[Debug] JOIN exact match: ${joinMatchExact}`);
            console.log(`[Debug] JOIN fallback match: ${joinFallbackMatch}`);
            
            if (joinMatchExact || joinFallbackMatch) {
                console.log(`[Debug] SUCCESS! JOIN match found for '${rivalName}'`);
                messageType = 'JOIN';
                detectedRivalName = rivalName;
                break;
            } else if (listMatchExact || listFallbackMatch) {
                console.log(`[Debug] 353 match found for '${rivalName}'`);
                messageType = '353';
                detectedRivalName = rivalName;
                break;
            }
        }
        
        if (messageType && detectedRivalName) {
            await this.triggerTampermonkeyAction(messageType, detectedRivalName);
        }
    }

    /**
     * Trigger Tampermonkey logic with detected message type and rival name
     */
    async triggerTampermonkeyAction(messageType, rivalName) {
        console.log(`[Puppeteer] Rival '${rivalName}' detected in WebSocket message (Type: ${messageType}). Triggering Tampermonkey.`);
        this.isTampermonkeyRunning = true;
        
        try {
            await this.page.evaluate((type, rivalName) => {
                if (typeof window.executeTampermonkeyLogic === 'function') {
                    console.log(`[Browser] Calling window.executeTampermonkeyLogic('${type}', '${rivalName}')`);
                    return Promise.resolve(window.executeTampermonkeyLogic(type, rivalName))
                        .catch(err => {
                            console.error('[Browser] Error executing executeTampermonkeyLogic:', err.message, err.stack);
                            if (typeof window.reportTampermonkeyError === 'function') {
                                window.reportTampermonkeyError(`Error in executeTampermonkeyLogic: ${err.message}`);
                            }
                        });
                } else {
                    console.error('[Browser] Error: window.executeTampermonkeyLogic is not defined!');
                    if (typeof window.reportTampermonkeyError === 'function') {
                        window.reportTampermonkeyError('executeTampermonkeyLogic function not found');
                    }
                    return Promise.reject(new Error('executeTampermonkeyLogic function not found'));
                }
            }, messageType, rivalName);
        } catch (evalError) {
            console.error(`[Puppeteer] Error during page.evaluate for Tampermonkey trigger: ${evalError}`);
            this.isTampermonkeyRunning = false;
        }
    }

    /**
     * Check current planet status and take appropriate action
     */
    async checkCurrentPlanetAndAct(payloadData) {
        if (this.stopMonitoring || !this.page || this.page.isClosed()) return;
        
        try {
            if (payloadData && (this.joinPrisonRegex.test(payloadData) || this.listPrisonRegex.test(payloadData) || this.prisonRegex.test(payloadData))) {
                console.log("[Planet Check] Detected prison planet via WebSocket payload! Triggering unlock sequence...");
                this.isPrisonMode = true;
                
                await this.page.evaluate(() => {
                    if (typeof window.executePrisonScript === 'function') {
                        window.executePrisonScript();
                    } else {
                        console.error('[Browser] executePrisonScript not defined');
                    }
                });
                // Do not call restartMonitoring here; let notifyPrisonScriptComplete handle it
            } else if (!payloadData) {
                console.log("[Planet Check] No payloadData available to check prison state.");
            }
        } catch (error) {
            console.error("[Planet Check] Error during planet verification:", error);
        }
    }

        /**
     * Restart monitoring after actions complete or errors
     */
    async restartMonitoring(payloadData) {
        if (this.stopMonitoring || !this.page || this.page.isClosed()) {
            console.log("[Puppeteer] Skipping restart (stop signal or page closed).");
            return;
        }

        console.log('[Puppeteer] Restarting monitoring cycle...');
        try {
            // Clean up existing CDP client
            await this.detachCDPClient();

            // Reload page to ensure fresh state
            console.log('[Puppeteer] Reloading page (waitUntil: domcontentloaded)...');
            await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
            console.log('[Puppeteer] Page reload initiated, DOMContentLoaded likely fired.');

            // Wait for Tampermonkey script to be ready
            await this.page.waitForFunction(() => window.tampermonkeyReady === true, { timeout: 30000 });
            console.log('[Puppeteer] Tampermonkey script is ready after reload.');

            // Check prison state with the provided payloadData (if any) after reload
            await this.checkCurrentPlanetAndAct(payloadData);

            // Parallelize configuration update and WebSocket listener setup
            await Promise.all([
                this.updateGMValues(),
                this.setupWebSocketListener()
            ]);

            console.log('[Puppeteer] Restart monitoring cycle setup complete.');
        } catch (reloadError) {
            console.error('[Puppeteer] Error during page reload/restart sequence:', reloadError);
            await this.takeScreenshotOnError();
            console.log('[Puppeteer] Critical error during reload/restart. Stopping monitoring and closing browser.');
            this.stopMonitoring = true;
            if (this.browser) {
                await this.browser.close().catch(e => console.error("Error closing browser after reload failure:", e));
                this.browser = null;
            }
            process.exit(1);
        }
    }

    /**
     * Helper: Take screenshot on error
     */
    async takeScreenshotOnError() {
        if (this.page && !this.page.isClosed()) {
            const screenshotPath = path.join(__dirname, `error_screenshot_${Date.now()}.png`);
            try {
                await this.page.screenshot({ path: screenshotPath, fullPage: true });
                console.log(`Screenshot saved to ${screenshotPath}`);
            } catch (ssError) {
                console.error(`Failed to take screenshot: ${ssError.message}`);
            }
        } else {
            console.log("Skipping screenshot: Page is closed or not available.");
        }
    }

    /**
     * Delay helper
     */
    async delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Start periodic status checks in parallel
     */
    async startPeriodicChecks() {
        const checkInterval = 30000; // Check every 30 seconds
        setInterval(async () => {
            if (this.stopMonitoring || !this.page || this.page.isClosed()) return;

            try {
                console.log("[Periodic Check] Verifying game state...");
                const isPrisonActive = await this.page.evaluate(() => {
                    return document.body.innerText.toUpperCase().includes('PRISON');
                });

                if (isPrisonActive && !this.isPrisonMode) {
                    console.log("[Periodic Check] Prison detected via DOM! Triggering unlock sequence...");
                    this.isPrisonMode = true;
                    await this.page.evaluate(() => {
                        if (typeof window.executePrisonScript === 'function') {
                            window.executePrisonScript();
                        } else {
                            console.error('[Browser] executePrisonScript not defined');
                        }
                    });
                }

                // Verify Tampermonkey readiness
                const tampermonkeyReady = await this.page.evaluate(() => window.tampermonkeyReady);
                if (tampermonkeyReady !== true) {
                    console.warn("[Periodic Check] Tampermonkey not ready, restarting monitoring...");
                    await this.restartMonitoring(null);
                }
            } catch (error) {
                console.error("[Periodic Check] Error during status check:", error);
            }
        }, checkInterval);
    }

    /**
     * Handle critical errors with recovery attempt
     */
    async handleCriticalError(error) {

        console.error('[Puppeteer] Critical error:', error);

        if (this.retryCount < this.maxRetries) {
            this.retryCount++;
            console.log(`[Puppeteer] Attempting recovery (Attempt ${this.retryCount}/${this.maxRetries})...`);

            try {
                // Attempt to clean up resources
                await this.detachCDPClient();
                if (this.page && !this.page.isClosed()) {
                    await this.page.close().catch(e => console.warn("Error closing page:", e));
                }
                if (this.browser) {
                    await this.browser.close().catch(e => console.warn("Error closing browser:", e));
                }

                // Wait with exponential backoff
                const backoffDelay = this.restartDelay * Math.pow(2, this.retryCount);
                console.log(`[Puppeteer] Waiting ${backoffDelay}ms before retry...`);
                await this.delay(backoffDelay);

                // Restart the entire process
                await this.launchBrowser();
                await this.setupPage();
                await this.injectScripts();
                await this.login();
                await this.initBrowserContext();
                await Promise.all([
                    this.updateGMValues(),
                    this.setupWebSocketListener()
                ]);

                console.log('[Puppeteer] Recovery successful. Resuming monitoring...');
                this.retryCount = 0; // Reset retry count on success
            } catch (recoveryError) {
                console.error('[Puppeteer] Recovery attempt failed:', recoveryError);
                await this.handleCriticalError(recoveryError); // Recursive retry
            }
        } else {
            console.error('[Puppeteer] Max retries reached. Shutting down...');
            await this.takeScreenshotOnError();
            this.stopMonitoring = true;
            if (this.browser) {
                await this.browser.close().catch(e => console.error("Error closing browser:", e));
            }
            process.exit(1);
        }
    }

    /**
     * Main entry point
     */
    async start() {
        try {
            await this.launchBrowser();
            await this.setupPage();
            await this.injectScripts();
            await this.login();
            await this.initBrowserContext();

            // Parallel initialization
            await Promise.all([
                this.updateGMValues(),
                this.setupWebSocketListener()
            ]);

            // Start periodic checks in parallel
            this.startPeriodicChecks();

            console.log('Initialization complete. Monitoring WebSocket messages...');
            // Keep the process running
            await new Promise(resolve => {});
        } catch (error) {
            await this.handleCriticalError(error);
        }
    }

    /**
     * Graceful shutdown
     */
    async shutdown() {
        console.log('\n[Puppeteer] SIGINT received. Shutting down gracefully...');
        this.stopMonitoring = true;

        try {
            await this.detachCDPClient();
            if (this.page && !this.page.isClosed()) {
                await this.page.close();
            }
            if (this.browser) {
                await this.browser.close();
            }
            console.log('[Puppeteer] Shutdown complete.');
        } catch (error) {
            console.error('[Puppeteer] Error during shutdown:', error);
        }
        process.exit(0);
    }
}

// Start the application
const automation = new GalaxyAutomation();
automation.start().catch(error => {
    console.error('Failed to start automation:', error);
    process.exit(1);
});

// Handle process termination
process.on('SIGINT', async () => {
    await automation.shutdown();
});
