const WebSocket = require('ws');
const fs = require('fs');
const { exec } = require('child_process');
const performance = require('perf_hooks').performance;

function formatTiming(ms) {
    return `${ms.toFixed(2)}ms`;
}

let socket;
let rivalDetectedTime = 0; // Will hold the precise detection timestamp in ms
let isReconnecting = false;
let flag = 0;
let count = 0;
let tempTime1 = 0;
let rivalDetectedViaWebSocket = false;
let currentAttackTime = 0;

// Remove estimated durations from static config
let config = {
    RC: '',
    AttackTime: 0,
    DefenceTime: 0,
    DefenceTime1: 0,
    planetName: '',
    interval: 0,
    rival: []
};

function loadConfig() {
    try {
        const data = fs.readFileSync('config1.json', 'utf8');
        const loadedConfig = JSON.parse(data);

        // Assign loaded values
        config.RC = loadedConfig.RC || '';
        config.AttackTime = loadedConfig.AttackTime || 0;
        config.DefenceTime = loadedConfig.DefenceTime || 0;
        config.planetName = loadedConfig.planetName || '';
        config.interval = loadedConfig.interval || 0;
        // Note: estimated durations are NOT loaded from config anymore

        // Handle rival array
        config.rival = Array.isArray(loadedConfig.rival) ? loadedConfig.rival : (loadedConfig.rival ? [loadedConfig.rival] : []);
        config.rival = config.rival.map(r => r.trim());

        // Update derived values
        config.DefenceTime1 = config.DefenceTime;
        tempTime1 = config.AttackTime;
        currentAttackTime = config.AttackTime; // Initialize currentAttackTime

        console.log('Config updated:', config);
    } catch (err) {
        console.error('Error reading or parsing config file:', err);
        // Keep existing config or defaults if loading fails
    }
}

loadConfig();

fs.watch('config1.json', (eventType) => {
    if (eventType === 'change') {
        console.log('Config file changed. Reloading...');
        loadConfig();
    }
});

async function handleError(error) {
    console.error("An error occurred:", error);
    try {
        await actions.reloadPage();
    } catch (reloadError) {
        console.error("Failed to reload page:", reloadError);
    }
}

function setupWebSocket() {
    try {
        socket = new WebSocket('ws://localhost:8080');

        socket.onopen = async function() {
            console.log(isReconnecting ? "Reconnection successful" : "Connected to WebSocket server");
            if (!isReconnecting) {
                await initialConnection();
            }
            isReconnecting = false;
        };

        socket.onclose = function() {
            if (!isReconnecting) {
                console.log("WebSocket connection closed.");
                handleError("Error");
                process.exit(1);
            }
        };

        socket.onerror = function(error) {
            console.error("WebSocket Error:", error);
            handleError(error);
        };

        // Enhanced message listener with precise timestamp handling
        socket.onmessage = function(event) {
            try {
                const message = JSON.parse(event.data);
                
                // Process the rivalDetected signal with precise timing
                if (message.action === 'rivalDetected') {
                    const detectedRival = message.rivalName;
                    // Use the exact timestamp received from the WebSocket server
                    const detectionTimestamp = message.timestamp;
                    
                    // Format the time for human-readable logs
                    const detectionTime = new Date(detectionTimestamp);
                    const timeString = detectionTime.toTimeString().split(' ')[0] + 
                                      '.' + detectionTime.getMilliseconds().toString().padStart(3, '0');
                    
                    console.log(`[WebSocket] Received rivalDetected signal for: ${detectedRival}`);
                    console.log(`[WebSocket] Detection time: ${timeString} (${detectionTimestamp}ms)`);
                    
                    // Store the exact timestamp for timing calculations
                    rivalDetectedTime = detectionTimestamp;
                    
                    // Set the detection flag
                    rivalDetectedViaWebSocket = true;
                }
            } catch (parseError) {
                console.error("[WebSocket] Error parsing message:", parseError, event.data);
            }
        };
    } catch(error) {
        handleError(error);
    }
}

async function sendMessage(message) {
    if (socket.readyState !== WebSocket.OPEN) {
        throw new Error(`WebSocket is not open. Current state: ${socket.readyState}`);
    }

    console.log("Sending message:", message);
    socket.send(JSON.stringify(message));

    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error('Timeout waiting for server response'));
        }, 10000);

        // This specific handler is added temporarily for *this* sendMessage call
        const messageHandler = (event) => {
            let response;
            try {
                response = JSON.parse(event.data);
            } catch (e) {
                // Ignore messages that aren't valid JSON or the targetDetected signal
                console.warn("[sendMessage Handler] Ignoring non-JSON message or parse error:", event.data);
                return;
            }

            // Only process if it's a response to the action we sent
            if (response.action === message.action) {
                clearTimeout(timeout);
                socket.removeEventListener('message', messageHandler); // Clean up this specific handler

                if (response.status === 'success') {
                    resolve(response);
                } else {
                    reject(new Error(response.message));
                }
            }
            // Other messages (like targetDetected) will be handled by the global socket.onmessage
        };

        socket.addEventListener('message', messageHandler);
    });
}
            /* Original relevant part: (This comment block was misplaced and is being removed)
            const response = JSON.parse(event.data);
            if (response.action !== message.action) return;

            clearTimeout(timeout);
            socket.removeEventListener('message', messageHandler);

            if (response.status === 'success') {
                resolve(response);
            } else {
                reject(new Error(response.message));
            }
        };

        socket.addEventListener('message', messageHandler);
    });
}*/ // End of removed misplaced comment block


const actions = {
    switchToFrame: async (frameIndex, selectorType, selector) => {
        try {
            return await sendMessage({ action: 'switchToFrame', frameIndex, selectorType, selector });
        } catch (error) {
            console.error('Error in switchToFrame:', error);
            throw error;
        }
    },
    switchToFramePlanet: async (frameIndex, selectorType, selector) => {
        try {
            return await sendMessage({ action: 'switchToFramePlanet', frameIndex, selectorType, selector });
        } catch (error) {
            console.error('Error in switchToFramePlanet:', error);
            throw error;
        }
    },
    switchToDefaultFrame: async (selector) => {
        try {
            return await sendMessage({ action: 'switchToDefaultFrame', selector });
        } catch (error) {
            console.error('Error in switchToDefaultFrame:', error);
            throw error;
        }
    },
    click: (selector) => sendMessage({ action: 'click', selector }),
	runAiChat: (user) => sendMessage({ action: 'runAiChat', user }),
    xpath: (xpath) => sendMessage({ action: 'xpath', xpath }),
    enterRecoveryCode: (code) => sendMessage({ action: 'enterRecoveryCode', code }),
    sleep: (ms) => sendMessage({ action: 'sleep', ms }),
    scroll: (selector) => sendMessage({ action: 'scroll', selector }),
    pressShiftC: (selector) => sendMessage({ action: 'pressShiftC', selector }),
    waitForClickable: (selector) => sendMessage({ action: 'waitForClickable', selector }),
    findAndClickByPartialText: async (text) => {
        try {
            let response = await sendMessage({ action: 'findAndClickByPartialText', text });
            if (!response || !('flag' in response)) {
                throw new Error('Flag not found in response');
            }
            return response;
        } catch (error) {
            console.error('Error in findAndClickByPartialText:', error);
            throw error;
        }
    },
    reloadPage: async () => {
        isReconnecting = true;
        try {
            await sendMessage({ action: 'reloadPage' });
            console.log("Page reloaded and WebSocket reconnected");
        } catch (error) {
            console.error("Error during page reload:", error);
        } finally {
            isReconnecting = false;
        }
    },
    checkUsername: async (rivals) => {
		try {
			// Convert single rival to array if needed
			const rivalsArray = Array.isArray(rivals) ? rivals : [rivals];
			const quotedRivals = rivalsArray.map(r => `${r.trim()}`);
			const result = await sendMessage({
				action: 'checkUsername',
				selector: '.planet-bar__item-name__name',
				expectedText: quotedRivals // Send array of trimmed rival names
			});
			return result.matches || false;
		} catch (error) {
			console.error('Error in checkUsername:', error);
			return false;
		}
    },
    searchAndClick: async (rivals) => {
        if (!Array.isArray(rivals)) throw new Error('rivals must be an array');
        try {
            let response = await sendMessage({ action: 'searchAndClick', rivals });
            if (!response || !('flag' in response) || !('matchedRival' in response)) {
                throw new Error('Flag or matchedRival not found in response');
            }
            return response;
        } catch (error) {
            console.error('Error in searchAndClick:', error);
            throw error;
        }
    },
    enhancedSearchAndClick: (position) => sendMessage({ action: 'enhancedSearchAndClick', position }),
    doubleClick: (selector) => sendMessage({ action: 'doubleClick', selector }),
    performSequentialActions: (actions) => sendMessage({ action: 'performSequentialActions', actions })
};

async function checkIfInPrison(planetName) {
    try {
        console.log("Checking if in prison...");
        const result = await actions.findAndClickByPartialText(planetName);
        console.log("Prison check result:", result);
        if (!result.flag) {
            await actions.waitForClickable('.planet-bar__button__action > img');
            await actions.click('.mdc-button > .mdc-top-app-bar__title');
            console.log("Prison element found and clicked");
            return true;
        } else {
            console.log("Not in prison");
            return false;
        }
    } catch (error) {
        console.error("Error in checkIfInPrison:", error);
        return false;
    }
}

async function autoRelease() {
    try {
           //actions.sleep(3000);
           const actionss = [
            { action: 'xpath', xpath: "//span[contains(.,'Planet Info')]" },
            { action: 'sleep', ms: 3000 },
            { action: 'switchToFrame', frameIndex: 1, selectorType: 'css', selector: '.free__early__release:nth-child(2) .free__early__release__title' },
            { action: 'sleep', ms: 250 },
            { action: 'switchToFrame', frameIndex: 1, selectorType: 'css', selector: '#yes_btn > p' },
            { action: 'sleep', ms: 250 },
            { action: 'switchToDefaultFrame', selector: '.mdc-icon-button > img' },
            { action: 'sleep', ms: 4000 },
            { action: 'switchToFrame', frameIndex: 1, selectorType: 'css', selector: '.s__gd__plank:nth-child(1) .text' },
            { action: 'sleep', ms: 500 },
            { action: 'switchToFramePlanet', frameIndex: 2, selectorType: 'css', selector: 'div.gc-action > a' }
        ];

        for (const action of actionss) {

            await sendMessage(action);
        }

        console.log("Auto-release successful. Reloading page...");
        await actions.reloadPage(); // Ensure reload is present
    } catch (error) {
        console.error("Error in autoRelease:", error);
        // Consider if reload is needed on error too, maybe not if main loop handles errors
        throw error;
    }
}

async function executeRivalChecks(planetName) {
    try {
        await actions.xpath(`//span[contains(.,'${planetName}')]`);
        await actions.xpath(`//span[contains(.,'Online now')]`);
        return true;
    } catch (error) {
        if (error.message === "No matching name found") {
            console.log("No matching name found");
            return false;
        }
        console.error("Error in executeRivalChecks:", error);
        throw error;
    }
}

async function imprison() {
    try {
        // First verification: Check if rival is present in the planet
        let rivalCheckResult1 = await actions.checkUsername(config.rival);

        if (rivalCheckResult1) {
            console.log("Rival verified successfully, proceeding with imprisonment");

            // Press Shift+C first
            await sendMessage({ action: 'pressShiftC', selector: ".planet-bar__button__action > img" });
            
            // Execute the final sequence immediately
            const finalSequenceActions = [
                { type: 'click', selector: ".dialog-item-menu__actions__item:last-child > .mdc-list-item__text" },
                { type: 'xpath', xpath: "//a[contains(.,'Exit')]" }
            ];

            // Send the final sequence
            await sendMessage({ action: 'performSequentialActions', actions: finalSequenceActions });

            console.log("Imprison actions completed successfully, reloading page...");
            await actions.reloadPage(); // Reload after successful imprison

        } else {
            console.log("Rival verification failed, reloading page...");
            await actions.reloadPage(); // Reload if rival check fails
        }
    } catch (error) {
        console.error("Error during imprison:", error);
        // Ensure safe exit even in case of error by reloading
        try {
            console.log("Attempting reload after imprison error...");
            await actions.reloadPage();
        } catch (reloadError) {
            console.error("Error during safe exit reload:", reloadError);
        }
        throw error;
    }
}
async function waitForElement(selector, maxAttempts = 5, interval = 50) {
    for (let i = 0; i < maxAttempts; i++) {
        try {
            await actions.waitForClickable(selector);
            return true;
        } catch (error) {
            if (i === maxAttempts - 1) throw error;
            await new Promise(resolve => setTimeout(resolve, interval));
        }
    }
    return false;
}
async function mainLoop() {
    while (true) {
        rivalDetectedViaWebSocket = false;
        rivalDetectedTime = 0;
        
        try {
            await actions.waitForClickable('.planet__events');

            const isInPrison = await checkIfInPrison(config.planetName);
            if (isInPrison) {
                console.log("In prison. Executing auto-release...");
                await autoRelease();
                continue;
            }

            if (!rivalDetectedViaWebSocket) {
                console.log("Rival not detected via WebSocket yet. Waiting...");
                continue;
            }
            
            console.log("Rival detected via WebSocket. Proceeding with planet/rival checks...");
            console.log(`Detection timestamp: ${rivalDetectedTime} (${new Date(rivalDetectedTime).toISOString()})`);

            let planetOk = false;
            try {
                console.log(`Checking for planet: ${config.planetName}`);
                await actions.xpath(`//span[contains(.,'${config.planetName}')]`);
                console.log(`Checking for 'Online now'`);
                await actions.xpath(`//span[contains(.,'Online now')]`);
                console.log("Clicked 'Online now'. Waiting for list...");
                await actions.sleep(150);
                console.log("Planet and Online status confirmed via xpath.");
                planetOk = true;
            } catch (planetError) {
                console.log(`Planet/Online check failed via xpath: ${planetError.message}. Retrying next loop.`);
                await actions.reloadPage();
                continue;
            }

            let rivalPresent = false;
            let matchedRivalName = null;
            if (planetOk) {
                console.log("Waiting for rival presence using XPath...");
                try {
                    let searchResult = await actions.searchAndClick(config.rival);
                    let found = searchResult.matchedRival;
                    if (searchResult.flag && found) {
                        rivalPresent = true;
                    } else {
                        rivalPresent = false;
                        console.log(`No configured rivals found via waitForXPath after checking all.`);
                    }
                } catch (generalError) {
                    console.error(`Error during rival XPath verification: ${generalError.message}.`);
                    rivalPresent = false;
                }
            } else {
                console.log("Planet check failed, skipping rival verification.");
            }

            if (rivalPresent) {
                // Use the precise timestamp for target execution time calculation
                const targetExecutionTime = rivalDetectedTime + currentAttackTime;
                const currentTime = Date.now();
                
                const waitTimeNeeded = Math.max(0, targetExecutionTime - currentTime);
                
                console.log(`Rival found. Will execute attack at time: ${targetExecutionTime} (${new Date(targetExecutionTime).toISOString()})`);
                console.log(`Current time: ${currentTime} (${new Date(currentTime).toISOString()})`);
                console.log(`Wait needed: ${waitTimeNeeded}ms`);

                await executeAttackSequence(waitTimeNeeded);

                currentAttackTime += config.interval;
                console.log(`Incremented attack time by ${config.interval}ms. New time: ${currentAttackTime}ms`);
                if (currentAttackTime > config.DefenceTime) {
                    currentAttackTime = config.AttackTime;
                    console.log(`Attack time exceeded defense time. Resetting to base: ${currentAttackTime}ms`);
                }
            } else {
                console.log("Rival not found by checkUsername or planet check failed. Skipping attack.");
            }
        } catch (error) {
            console.error(`Error in main loop: ${error.message}. Stack: ${error.stack}`);
            await actions.reloadPage();
        }
    }
}

// Simplified function: waits for sleep, then attempts imprison
async function executeAttackSequence(targetTime) {
    try {
        if (targetTime > 0) {
            console.log(`Waiting ${targetTime}ms until target execution time`);
            const waitStart = Date.now();
            await actions.sleep(targetTime);
            const actualWaitTime = Date.now() - waitStart;
            console.log(`Wait complete. Requested: ${targetTime}ms, Actual: ${actualWaitTime}ms`);
        } else {
            console.log("Target execution time already passed. Proceeding immediately.");
        }

        console.log(`Executing imprison action at: ${Date.now()} (${new Date().toISOString()})`);
        await imprison();
        console.log("Imprison action successful.");
    } catch (error) {
        console.error(`Error during attack sequence: ${error.message}`);
        throw error;
    }
}

async function initialConnection() {
    try {
        await actions.sleep(4000);
        await actions.waitForClickable('.mdc-button--black-secondary > .mdc-button__label');
        //await actions.xpath("//a[2]/div");
        await actions.click('.mdc-button--black-secondary > .mdc-button__label');
        console.log("First button clicked");
        await actions.enterRecoveryCode(config.RC);
        console.log("Recovery code entered");
        await actions.click('.mdc-dialog__button:nth-child(2)');
        console.log("Second button clicked");
		await actions.runAiChat("]--BEAST--["); //change this
        await mainLoop();
    } catch (error) {
        await handleError(error);
    }
}

setupWebSocket();
