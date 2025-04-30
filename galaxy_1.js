const puppeteer = require('puppeteer');
const fs = require('fs').promises;
const fsSync = require('fs'); // For file watching
const path = require('path');
const { Buffer } = require('buffer'); // Needed for potential Base64 decoding

let rivalNames = [];
let planetName = "";
let joinRegexes = [];
let listRegexes = [];
const PATTERNS_PER_RIVAL = 2;

function updateConfigValues() {
    try {
        delete require.cache[require.resolve('./config1.json')];
        config = require('./config1.json');
        
        rivalNamesArg = Array.isArray(config.rival) ? config.rival.join(',') : config.rival;
        planetNameArg = config.planetName;
        recoveryCodeArg = config.RC;
        
        timingParams.startAttack = config.startAttackTime || 0;
        timingParams.startIntervalAttack = config.attackIntervalTime || 100;
        timingParams.stopAttack = config.stopAttackTime || 5000;
        timingParams.startDefence = config.startDefenceTime || 0;
        timingParams.startDefenceInterval = config.defenceIntervalTime || 100;
        timingParams.stopDefence = config.stopDefenceTime || 5000;
        
        console.log("Configuration updated from file:", config);
        
        const returnValues = {
            newAttackDelay: timingParams.startAttack,
            newDefenceDelay: timingParams.startDefence
        };
        
        rivalNames = rivalNamesArg.split(',').map(name => name.trim());
        console.log("Updated rival names array:", rivalNames);
        
        planetName = planetNameArg || "";
        rebuildRegexPatterns();
        
        return returnValues;
    } catch (error) {
        console.error("Error updating config:", error);
        return null;
    }
}

function rebuildRegexPatterns() {
    joinRegexes = [];
    listRegexes = [];
    
rivalNames.forEach((rivalName) => {
  const e = escapeRegex(rivalName);

  // only match @?e when it's preceded by start/space and followed by space/end
  // 1. lookbehind (?<=^|[\s@])  
  // 2. lookahead  (?=$|[\s])
  
  // JOIN: numeric reply
  joinRegexes.push(new RegExp(
    `JOIN\\s+[-\\s\\w]*?(?<=^|[\\s@])${e}(?=$|[\\s])\\s+\\d+`, 'i'
  ));
  // JOIN: fallback
  joinRegexes.push(new RegExp(
    `JOIN.*?(?<=^|[\\s@])${e}(?=$|[\\s])`,                'i'
  ));

  // 353: numeric list entry
  listRegexes.push(new RegExp(
    `353\\s+\\d+.*?(?<=^|[\\s@])${e}(?=$|[\\s])\\s+\\d+`, 'i'
  ));
  // 353: fallback list entry
  listRegexes.push(new RegExp(
    `353.*?(?<=^|[\\s@])${e}(?=$|[\\s])`,                  'i'
  ));
});
    
    console.log("[Debug] Rebuilt JOIN regex patterns:");
    joinRegexes.forEach((regex, i) => console.log(`  [${i}]: ${regex}`));
}

let config;
let rivalNamesArg, planetNameArg, recoveryCodeArg, timingParams = {};
updateConfigValues();

async function updateGMValues() {
    if (!page || page.isClosed()) return;
    
    try {
        const currentRivalNames = Array.isArray(config.rival) ? config.rival.join(',') : config.rival;
        const currentPlanetName = config.planetName;
        
        await page.evaluate(async (names, planet, params) => {
            if (typeof window.GM_setValue !== 'function') {
                console.error('[Browser] GM_setValue function not found!');
                return;
            }
            
            await window.GM_setValue('RIVAL_NAMES', names);
            await window.GM_setValue('PLANET_NAME', planet);
            await window.GM_setValue('TIMING_PARAMS', JSON.stringify(params));
            await window.GM_setValue('CURRENT_ATTACK_DELAY', params.startAttack);
            await window.GM_setValue('CURRENT_DEFENCE_DELAY', params.startDefence);
            
            console.log('[Browser] Configuration fully updated via GM_setValue with values:', 
                { names, planet, params, 
                  currentAttackDelay: params.startAttack, 
                  currentDefenceDelay: params.startDefence });
        }, currentRivalNames, currentPlanetName, timingParams);
        
        console.log("Successfully updated all GM values in browser context");
    } catch (error) {
        console.error("Error updating GM values:", error);
    }
}

fsSync.watch('config1.json', async (eventType, filename) => {
    if (eventType === 'change') {
        console.log('Config file changed, updating values...');
        
        const newDelays = updateConfigValues(); // Always update local variables
        
        if (newDelays && page && !page.isClosed()) {
            try {
                if (!isPrisonMode) {
                    // If not in prison mode, update GM values and restart listener immediately
                    await updateGMValues();
                    if (cdpClient) {
                        console.log("Config changed, restarting WebSocket monitoring...");
                        await cdpClient.removeAllListeners();
                        await cdpClient.detach().catch(e => console.warn("Warning: Error detaching CDP client after config change:", e.message));
                        cdpClient = null;
                        await setupWebSocketListener();
                    }
                } else {
                    // During prison mode, defer GM update and listener restart
                    console.log('Prison mode active, deferring GM value update and listener restart until after prison script completes.');
                }
                console.log('Configuration update handled.');
            } catch (error) {
                console.error("Error handling config change:", error);
            }
        }
    }
});
if (rivalNames.length === 0) {
    rivalNames = rivalNamesArg.split(',').map(name => name.trim());
}
if (!planetName) {
    planetName = planetNameArg || "";
}

const scriptPath = path.join(__dirname, 'login.user_1.js');
const prisonScriptPath = path.join(__dirname, 'prison.user_1.js');
const targetUrl = 'https://galaxy.mobstudio.ru/web/';
const recoveryCode = recoveryCodeArg;
const postLoginSelector = '.mdc-button > .mdc-top-app-bar__title';

console.log("=== Galaxy Auto-Attacker Configuration ===");
console.log(`Target URL: ${targetUrl}`);
console.log(`Rival Names: ${rivalNames.join(', ')}`);
console.log(`Planet Name: ${planetName}`);
console.log("Timing Parameters:", timingParams);
console.log("=======================================");

let browser;
let page;
let cdpClient = null;
let isTampermonkeyRunning = false;
let stopMonitoring = false;
let isPrisonMode = false;

function escapeRegex(str) {
    if (!str) return '';
    return str.replace(/[.*+?^${}()|[\]\\`]/g, '\\$&');
}

rivalNames.forEach((rivalName) => {
  const e = escapeRegex(rivalName);

  // only match @?e when it's preceded by start/space and followed by space/end
  // 1. lookbehind (?<=^|[\s@])  
  // 2. lookahead  (?=$|[\s])
  
  // JOIN: numeric reply
  joinRegexes.push(new RegExp(
    `JOIN\\s+[-\\s\\w]*?(?<=^|[\\s@])${e}(?=$|[\\s])\\s+\\d+`, 'i'
  ));
  // JOIN: fallback
  joinRegexes.push(new RegExp(
    `JOIN.*?(?<=^|[\\s@])${e}(?=$|[\\s])`,                'i'
  ));

  // 353: numeric list entry
  listRegexes.push(new RegExp(
    `353\\s+\\d+.*?(?<=^|[\\s@])${e}(?=$|[\\s])\\s+\\d+`, 'i'
  ));
  // 353: fallback list entry
  listRegexes.push(new RegExp(
    `353.*?(?<=^|[\\s@])${e}(?=$|[\\s])`,                  'i'
  ));
});

console.log("[Debug] JOIN regex patterns:");
joinRegexes.forEach((regex, i) => console.log(`  [${i}]: ${regex}`));

let planetRegex = null;
if (planetName) {
    const escapedPlanetName = escapeRegex(planetName);
    planetRegex = new RegExp(escapedPlanetName, 'i');
}

const prisonRegex = /\bPRISON\b/i;
const joinPrisonRegex = /JOIN\s*.+?Prison/i;
const listPrisonRegex = /353\s*.+?Prison/i;

(async () => {
    try {
        console.log('Launching browser...');
        browser = await puppeteer.launch({
            headless: "new",
            args: [
                '--start-maximized',
                '--disable-infobars',
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-setuid-sandbox',
                '--disable-web-security',
                '--disable-features=IsolateOrigins,site-per-process',
                '--disable-csp'
            ],
        });
        page = await browser.newPage();
        console.log('Browser launched, new page created.');

        page.on('console', msg => {
            const type = msg.type().toUpperCase();
            const text = msg.text();
            console.log(`[BROWSER ${type}] ${text}`);
        });
        page.on('pageerror', error => console.error(`[BROWSER PAGEERROR] ${error.message}\n${error.stack}`));
        page.on('requestfailed', request => console.warn(`[BROWSER REQFAIL] ${request.method()} ${request.url()} ${request.failure()?.errorText}`));
        page.on('close', () => {
            console.log('[Puppeteer] Page closed event detected.');
            stopMonitoring = true;
            if (cdpClient && cdpClient.connection()) {
                cdpClient.detach().catch(e => console.error("Error detaching CDP on close:", e));
                cdpClient = null;
            }
        });

        await page.setViewport({ width: 1366, height: 768 });
        console.log('Viewport set.');

        console.log('Exposing functions for Tampermonkey...');
        const storage = {};
        await page.exposeFunction('GM_getValue_puppeteer', async (k, d) => storage[k] ?? d);
        await page.exposeFunction('GM_setValue_puppeteer', (k, v) => {
            storage[k] = v;
            return v;
        });
        
        await page.exposeFunction('notifyPrisonScriptComplete', async (status) => {
            if (stopMonitoring) return;
            console.log(`[Puppeteer] Prison unlock script completed. Status: ${status}`);
            isPrisonMode = false;
            await restartMonitoring(null);
        });
        
        await page.exposeFunction('notifyPuppeteerComplete', async (status) => {
            if (stopMonitoring) return;
            console.log(`[Puppeteer] Tampermonkey signaled completion. Status: ${status}`);
            isTampermonkeyRunning = false;
            await restartMonitoring(null);
        });
        
        await page.exposeFunction('reportTampermonkeyError', (errorMessage) => {
            console.error(`[Tampermonkey ERROR REPORT] ${errorMessage}`);
        });
        console.log('Functions exposed.');

        console.log(`Injecting Tampermonkey script: ${scriptPath}`);
        const userScript = await fs.readFile(scriptPath, 'utf8');
        console.log(`Loading prison unlock script: ${prisonScriptPath}`);
        const prisonScript = await fs.readFile(prisonScriptPath, 'utf8');
        await page.evaluateOnNewDocument((userScriptContent, prisonScriptContent) => {
            console.log('[Browser] Setting up GM environment in evaluateOnNewDocument...');
            
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
            
            window.prisonScriptContent = prisonScriptContent;
            window.userScriptContent = userScriptContent;
            
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
            
            document.addEventListener('DOMContentLoaded', () => {
                console.log('[Browser] DOMContentLoaded event fired, executing user script...');
                window.executeUserScript();
            });
            
            console.log('[Browser] evaluateOnNewDocument setup complete');
        }, userScript, prisonScript);

        console.log('Navigating to target site...');
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

        console.log('After navigation, verifying script execution...');
        await page.evaluate(() => {
            console.log('[Browser] In page.evaluate verification');
            console.log('[Browser] tampermonkeyReady =', window.tampermonkeyReady);
            console.log('[Browser] executeTampermonkeyLogic exists =', typeof window.executeTampermonkeyLogic === 'function');
        });

        try {
            await page.evaluate((script) => {
                new Function(script)();
            }, userScript);
            console.log('[Browser] UserScript evaluated successfully.');
        } catch (e) {
            console.error('[Browser] Error executing UserScript:', e.message, e.stack);
        }

        console.log('Navigation complete.');
        await delay(3000);
        await page.evaluate(() => {
            const button = document.querySelector('.mdc-button--black-secondary');
            if (button) {
                button.click();
                return true;
            }
            return false;
        });
        await page.click('input[name="recoveryCode"]', { visible: true });
        await page.type('input[name="recoveryCode"]', recoveryCode, { delay: 50 });
        console.log('Waiting for final login button...');
        await page.click('.mdc-dialog__button:nth-child(2)');
        console.log('Login navigation likely complete.');
        await delay(550);
        const pageContent = await page.content();
        console.log('Page title:', await page.title());
        console.log('Scripts on page:', await page.evaluate(() => {
            return Array.from(document.querySelectorAll('script')).map(s => s.src || 'inline');
        }));
        await page.evaluate(() => {
            console.log("[Debug] Window properties:", Object.keys(window));
            console.log("[Debug] tampermonkeyReady value:", window.tampermonkeyReady);
            window.tampermonkeyReady = window.tampermonkeyReady || true;
        });

        await page.waitForFunction(() => {
            return window.tampermonkeyReady === true || 
                   window.tampermonkeyReady === 'error';
        }, { timeout: 45000 });

        const readyState = await page.evaluate(() => window.tampermonkeyReady);
        if (readyState !== true) {
            throw new Error(`Tampermonkey script failed to initialize: ${readyState}`);
        }

        // *** Optimization 1: Parallel Configuration Storage and WebSocket Setup ***
        console.log('Storing configuration and setting up WebSocket listener in parallel...');
        await Promise.all([
            page.evaluate(async (names, planet, params) => {
                await window.GM_setValue('RIVAL_NAMES', names);
                await window.GM_setValue('PLANET_NAME', planet);
                await window.GM_setValue('TIMING_PARAMS', JSON.stringify(params));
                console.log('[Browser] Rival names, planet name and timing stored via GM_setValue.');
            }, rivalNames, planetName, timingParams),
            setupWebSocketListener()
        ]);
        console.log('Parallel setup complete.');

        console.log('Initialization complete. Monitoring WebSocket messages...');
        await new Promise(resolve => {});

    } catch (error) {
        console.error('Error in main Puppeteer script:', error);
        await takeScreenshotOnError(page);
        stopMonitoring = true;
        if (browser) {
            await browser.close().catch(e => console.error("Error closing browser during error handling:", e));
        }
        process.exit(1);
    }
})();

async function setupWebSocketListener() {
    if (stopMonitoring || !page || page.isClosed()) {
        console.log("[Puppeteer] Skipping WebSocket listener setup (stop signal or page closed).");
        return;
    }

    if (cdpClient) {
        console.log("[Puppeteer] Detaching existing CDP session before creating new one.");
        try {
            await cdpClient.removeAllListeners();
            await cdpClient.detach();
        } catch (e) {
            console.warn("Warning: Error detaching previous CDP client:", e.message);
        }
        cdpClient = null;
    }

    try {
        console.log('[Puppeteer] Setting up WebSocket listener...');
        isTampermonkeyRunning = false;
        isPrisonMode = false;

        cdpClient = await page.target().createCDPSession();
        await cdpClient.send('Network.enable');
        console.log('[Puppeteer] CDP Network domain enabled.');

        const webSocketFrameReceivedListener = async ({ requestId, timestamp, response }) => {
            if (stopMonitoring) return;
            if (isTampermonkeyRunning || isPrisonMode) {
                return;
            }
            if (!page || page.isClosed()) {
                console.log('[Puppeteer WS] Skipping message - Page is closed.');
                if (cdpClient) await cdpClient.detach().catch(e => e);
                return;
            }
            if (response.opcode !== 1) {
                return;
            }
        
            const payloadData = response.payloadData;
            console.log(`[Puppeteer WS Received] Payload: ${payloadData.substring(0, 200)}...`);
        
            try {
                if (joinPrisonRegex.test(payloadData) || listPrisonRegex.test(payloadData) || prisonRegex.test(payloadData)) {
                    console.log('[Puppeteer] Prison detected in WebSocket message. Triggering prison unlock script.');
                    isPrisonMode = true;
                    
                    await page.evaluate(() => {
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
                    }).catch(evalError => {
                        console.error(`[Puppeteer] Error during page.evaluate for prison script: ${evalError}`);
                        isPrisonMode = false;
                    });
                    return;
                }
        
                console.log(`[Debug] Current rival names being checked: ${rivalNames.join(', ')}`);
                console.log(`[Debug] Current joinRegexes length: ${joinRegexes.length}`);
        
                let messageType = null;
                let detectedRivalName = null;
        
                for (let i = 0; i < rivalNames.length; i++) {
                    const rivalName = rivalNames[i];
                    
                    const joinExactIndex    = i * PATTERNS_PER_RIVAL;
					const joinFallbackIndex = joinExactIndex + 1;

					const joinMatchExact    = !!joinRegexes[joinExactIndex]?.test(payloadData);
					const joinFallbackMatch = !!joinRegexes[joinFallbackIndex]?.test(payloadData);
					const listExactIndex    = i * PATTERNS_PER_RIVAL;
					const listFallbackIndex = listExactIndex + 1;
					const listMatchExact    = !!listRegexes[listExactIndex]?.test(payloadData);
					const listFallbackMatch = !!listRegexes[listFallbackIndex]?.test(payloadData)
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
                    console.log(`[Puppeteer] Rival '${detectedRivalName}' detected in WebSocket message (Type: ${messageType}). Triggering Tampermonkey.`);
                    isTampermonkeyRunning = true;
                    await page.evaluate((type, rivalName) => {
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
                    }, messageType, detectedRivalName).catch(evalError => {
                        console.error(`[Puppeteer] Error during page.evaluate for Tampermonkey trigger: ${evalError}`);
                        isTampermonkeyRunning = false;
                    });
                }
        
                await checkCurrentPlanetAndAct(payloadData);
        
            } catch (parseOrCheckError) {
                console.warn(`[Puppeteer] Error processing WebSocket message: ${parseOrCheckError.message}. Payload: ${payloadData.substring(0, 100)}...`);
            }
        };
        cdpClient.on('Network.webSocketFrameReceived', webSocketFrameReceivedListener);

        cdpClient.on('error', (error) => {
            console.error('[Puppeteer] CDP Error:', error);
        });
        cdpClient.on('sessiondetached', () => {
            console.warn('[Puppeteer] CDP session detached.');
            cdpClient = null;
            if (!stopMonitoring) {
                console.log('[Puppeteer] Attempting to restart monitoring after CDP detachment...');
                setTimeout(() => restartMonitoring(null), 5000);
            }
        });

        console.log('[Puppeteer] WebSocket listener is active.');

    } catch (cdpError) {
        console.error(`[Puppeteer] Failed to setup WebSocket listener: ${cdpError}`);
        if (!stopMonitoring) {
            console.log('[Puppeteer] Retrying listener setup after error...');
            setTimeout(() => restartMonitoring(null), 10000);
        }
    }
}

async function checkCurrentPlanetAndAct(payloadData) {
    if (stopMonitoring || !page || page.isClosed()) return;
    try {
        if (payloadData && (joinPrisonRegex.test(payloadData) || listPrisonRegex.test(payloadData) || prisonRegex.test(payloadData))) {
            console.log("[Planet Check] Detected prison planet via WebSocket payload! Triggering unlock sequence...");
            isPrisonMode = true;
            
            await page.evaluate(() => {
                if (typeof window.executePrisonScript === 'function') {
                    window.executePrisonScript();
                } else {
                    console.error('[Browser] executePrisonScript not defined');
                }
            });
        } else if (!payloadData) {
            console.log("[Planet Check] No payloadData available to check prison state.");
        }
    } catch (error) {
        console.error("[Planet Check] Error during planet verification:", error);
    }
}

async function restartMonitoring(payloadData) {
    if (stopMonitoring || !page || page.isClosed()) {
        console.log("[Puppeteer] Skipping restart (stop signal or page closed).");
        return;
    }

    console.log('[Puppeteer] Restarting monitoring cycle...');
    try {
        if (cdpClient) {
            await cdpClient.removeAllListeners();
            await cdpClient.detach().catch(e => console.warn("Warning: Error detaching CDP client before reload:", e.message));
            cdpClient = null;
        }

        console.log('[Puppeteer] Reloading page (waitUntil: domcontentloaded)...');
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
        console.log('[Puppeteer] Page reload initiated, DOMContentLoaded likely fired.');

        await page.waitForFunction(() => window.tampermonkeyReady === true, { timeout: 30000 });
        console.log('[Puppeteer] Tampermonkey script is ready after reload.');

        await checkCurrentPlanetAndAct(payloadData);

        // *** Optimization 2: Parallel Configuration Update and WebSocket Setup ***
        console.log('[Puppeteer] Updating configuration and setting up WebSocket listener in parallel...');
        await Promise.all([
            page.evaluate(async (names, planet, params) => {
                if (typeof window.GM_setValue !== 'function') {
                    console.error('[Browser] GM_setValue function not found after reload!');
                    return;
                }
                await window.GM_setValue('RIVAL_NAMES', names);
                await window.GM_setValue('PLANET_NAME', planet);
                await window.GM_setValue('TIMING_PARAMS', JSON.stringify(params));
                console.log('[Browser] Configuration stored via GM_setValue.');
            }, rivalNames, planetName, timingParams),
            setupWebSocketListener()
        ]);
        console.log('[Puppeteer] Parallel setup tasks completed.');
        console.log('[Puppeteer] Restart monitoring cycle setup complete.');

    } catch (reloadError) {
        console.error('[Puppeteer] Error during page reload/restart sequence:', reloadError);
        await takeScreenshotOnError(page);
        console.log('[Puppeteer] Critical error during reload/restart. Stopping monitoring and closing browser.');
        stopMonitoring = true;
        if (browser) {
            await browser.close().catch(e => console.error("Error closing browser after reload failure:", e));
            browser = null;
        }
        process.exit(1);
    }
}

async function takeScreenshotOnError(pageInstance) {
    if (pageInstance && !pageInstance.isClosed()) {
        const screenshotPath = path.join(__dirname, `error_screenshot_${Date.now()}.png`);
        try {
            await pageInstance.screenshot({ path: screenshotPath, fullPage: true });
            console.log(`Screenshot saved to ${screenshotPath}`);
        } catch (ssError) {
            console.error(`Failed to take screenshot: ${ssError.message}`);
        }
    } else {
        console.log("Skipping screenshot: Page is closed or not available.");
    }
}

process.on('SIGINT', async () => {
    console.log('\n[Puppeteer] SIGINT received. Shutting down gracefully...');
    stopMonitoring = true;
    if (cdpClient) {
        console.log('[Puppeteer] Detaching CDP client...');
        await cdpClient.detach().catch(e => console.error("Error detaching CDP on SIGINT:", e.message));
    }
    if (browser) {
        console.log('[Puppeteer] Closing browser...');
        await browser.close();
        browser = null;
    }
    console.log('[Puppeteer] Shutdown complete.');
    process.exit(0);
});

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}