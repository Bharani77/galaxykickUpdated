const puppeteer = require('puppeteer');
const fs = require('fs').promises;
const fsSync = require('fs');  // For file watching
const path = require('path');
const { Buffer } = require('buffer'); // Needed for potential Base64 decoding

// Function to update config values
function updateConfigValues() {
    try {
        // Clear require cache to get fresh config
        delete require.cache[require.resolve('./config1.json')];
        config = require('./config1.json');
        
        // Update values
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
    } catch (error) {
        console.error("Error updating config:", error);
    }
}

// Initial config read
let config;
let rivalNamesArg, planetNameArg, recoveryCodeArg, timingParams = {};
updateConfigValues();

// Add this new function to update GM values
async function updateGMValues() {
    if (!page || page.isClosed()) return;
    
    try {
        await page.evaluate(async (names, planet, params) => {
            if (typeof window.GM_setValue !== 'function') {
                console.error('[Browser] GM_setValue function not found!');
                return;
            }
            await window.GM_setValue('RIVAL_NAMES', names);
            await window.GM_setValue('PLANET_NAME', planet);
            await window.GM_setValue('TIMING_PARAMS', JSON.stringify(params));
            console.log('[Browser] Configuration updated via GM_setValue');
        }, rivalNames, planetName, timingParams);
    } catch (error) {
        console.error("Error updating GM values:", error);
    }
}

// Watch for config file changes
fsSync.watch('config1.json', (eventType, filename) => {
    if (eventType === 'change') {
        console.log('Config file changed, updating values...');
        updateConfigValues();
        // Update GM values after config is updated
        updateGMValues();
    }
});

// Set variables from config
const rivalNames = rivalNamesArg.split(',');
const planetName = planetNameArg || ""; // Default to empty string if not provided

// --- Configuration ---
const scriptPath = path.join(__dirname, 'login.user_1.js'); // Your Tampermonkey script path
const prisonScriptPath = path.join(__dirname, 'prison.user_1.js'); // Path to the prison unlock script
const targetUrl = 'https://galaxy.mobstudio.ru/web/';
const recoveryCode = recoveryCodeArg; // Default to the original value if not provided
const postLoginSelector = '.mdc-button > .mdc-top-app-bar__title'; // Selector to verify login

// --- Display Configuration ---
console.log("=== Galaxy Auto-Attacker Configuration ===");
console.log(`Target URL: ${targetUrl}`);
console.log(`Rival Names: ${rivalNames.join(', ')}`);
console.log(`Planet Name: ${planetName}`);
console.log("Timing Parameters:", timingParams);
console.log("=======================================");

let browser; // Make browser accessible in the outer scope for cleanup
let page; // Make page accessible
let cdpClient = null; // To hold the CDP session
let isTampermonkeyRunning = false; // Flag to prevent concurrent runs
let stopMonitoring = false; // Flag to signal shutdown
let isPrisonMode = false; // Flag to track if we're handling a prison

// Helper to escape regex characters in rival name
function escapeRegex(str) {
    if (!str) return '';
    return str.replace(/[.*+?^${}()|[\]\\`]/g, '\\$&');
}

// Create regex patterns for each rival name
const joinRegexes = [];
const listRegexes = [];
rivalNames.forEach((rivalName) => {
    const escapedRivalName = escapeRegex(rivalName);
    console.log(`[Setup] Created escaped regex for '${rivalName}': ${escapedRivalName}`);
    
    joinRegexes.push(new RegExp(`JOIN\\s+[-\\s\\w]*${escapedRivalName}\\s+\\d+`, 'i')); 
    listRegexes.push(new RegExp(`353\\s+\\d+.*?@?${escapedRivalName}\\s+\\d+`, 'i'));
    joinRegexes.push(new RegExp(`JOIN.*?${escapedRivalName}`, 'i'));
    listRegexes.push(new RegExp(`353.*?${escapedRivalName}`, 'i'));
});

console.log("[Debug] JOIN regex patterns:");
joinRegexes.forEach((regex, i) => console.log(`  [${i}]: ${regex}`));

// Create regex pattern for planet name if provided
let planetRegex = null;
if (planetName) {
    const escapedPlanetName = escapeRegex(planetName);
    planetRegex = new RegExp(escapedPlanetName, 'i'); // Case insensitive
}

// Prison detection regex
const prisonRegex = /\bPRISON\b/i;
const joinPrisonRegex = /JOIN\s*.+?Prison/i;
const listPrisonRegex = /353\s*.+?Prison/i;

// --- Main Async Function ---
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

        // --- Console/Error Logging from Browser ---
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

        // --- Storage Simulation & Tampermonkey Communication ---
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
            await restartMonitoring(null); // No payloadData available here
        });
        
        await page.exposeFunction('notifyPuppeteerComplete', async (status) => {
            if (stopMonitoring) return;
            console.log(`[Puppeteer] Tampermonkey signaled completion. Status: ${status}`);
            isTampermonkeyRunning = false;
            await restartMonitoring(null); // No payloadData available here
        });
        
        await page.exposeFunction('reportTampermonkeyError', (errorMessage) => {
            console.error(`[Tampermonkey ERROR REPORT] ${errorMessage}`);
        });
        console.log('Functions exposed.');

        // --- UserScript Injection ---
        console.log(`Injecting Tampermonkey script: ${scriptPath}`);
        const userScript = await fs.readFile(scriptPath, 'utf8');
        console.log(`Loading prison unlock script: ${prisonScriptPath}`);
        const prisonScript = await fs.readFile(prisonScriptPath, 'utf8');
await page.evaluateOnNewDocument((userScriptContent, prisonScriptContent) => {
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

// After page load, verify script execution and function availability
console.log('Navigating to target site...');
await page.goto(targetUrl, { waitUntil: 'networkidle0', timeout: 90000 });

// After navigation completes
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
        await page.click('.mdc-button--black-secondary > .mdc-button__label', { visible: true });
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
			// Force setting ready status for testing
			window.tampermonkeyReady = window.tampermonkeyReady || true;
		});
        // Wait for Tampermonkey script to be ready
        await page.waitForFunction(() => {
				return window.tampermonkeyReady === true || 
					   window.tampermonkeyReady === 'error';
			}, { timeout: 45000 });

			const readyState = await page.evaluate(() => window.tampermonkeyReady);
			if(readyState !== true) {
				throw new Error(`Tampermonkey script failed to initialize: ${readyState}`);
			}

        // --- Set Configuration Parameters in Browser Context ---
        console.log('Storing rival names, planet name and timing parameters for Tampermonkey...');
        await page.evaluate(async (names, planet, params) => {
            await window.GM_setValue('RIVAL_NAMES', names);
            await window.GM_setValue('PLANET_NAME', planet);
            await window.GM_setValue('TIMING_PARAMS', JSON.stringify(params));
            console.log('[Browser] Rival names, planet name and timing stored via GM_setValue.');
        }, rivalNames, planetName, timingParams);
        console.log('Configuration stored in browser context.');

        // --- Initial Start of Monitoring ---
        await setupWebSocketListener();

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

// --- WebSocket Monitoring Function ---
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

                let messageType = null;
                let detectedRivalName = null;

                for (let i = 0; i < rivalNames.length; i++) {
                    const rivalName = rivalNames[i];
                    const joinMatchExact = joinRegexes[i].test(payloadData);
                    const joinFallbackMatch = joinRegexes[i + rivalNames.length].test(payloadData);
                    const listMatchExact = listRegexes[i].test(payloadData);
                    const listFallbackMatch = listRegexes[i + rivalNames.length].test(payloadData);

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

                // Pass payloadData to checkCurrentPlanetAndAct
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

// --- Updated checkCurrentPlanetAndAct Function ---
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
            // Do not call restartMonitoring here; let notifyPrisonScriptComplete handle it
        } else if (!payloadData) {
            console.log("[Planet Check] No payloadData available to check prison state.");
        }
    } catch (error) {
        console.error("[Planet Check] Error during planet verification:", error);
    }
}
// --- Updated restartMonitoring Function ---
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

        // Wait for Tampermonkey script to be ready
        await page.waitForFunction(() => window.tampermonkeyReady === true, { timeout: 30000 });
        console.log('[Puppeteer] Tampermonkey script is ready after reload.');

        // Check prison state with the provided payloadData (if any) after reload
        await checkCurrentPlanetAndAct(payloadData);

        try {
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
        } catch (parallelError) {
            console.error('[Puppeteer] Error during parallel setup:', parallelError);
            throw parallelError;
        }

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
// --- Helper: Screenshot on Error ---
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

// --- Graceful Shutdown ---
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