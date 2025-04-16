const WebSocket = require('ws');
const fs = require('fs');
const { exec } = require('child_process');

// Add these utility functions near the top of the file
const performance = require('perf_hooks').performance;

function formatTiming(ms) {
    return `${ms.toFixed(2)}ms`;
}

let socket;
let isReconnecting = false;
let flag = 0;
let count = 0;
let tempTime1 = 0;
let rivalDetectedViaWebSocket = false; // Flag to track if a rival was detected via external WebSocket
let currentAttackTime = 0; // Variable to hold the dynamic attack time;

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

        // --- Add WebSocket message listener for targetDetected ---
        // This global listener handles incoming messages that aren't direct replies to sendMessage
        socket.onmessage = function(event) {
            try {
                const message = JSON.parse(event.data);
                // Check if it's the rival detection signal from test_1.js
                if (message.action === 'rivalDetected') {
                    console.log(`[WebSocket] Received rivalDetected signal for: ${message.rivalName}`);
                    rivalDetectedViaWebSocket = true; // Set the new flag
                }
                // Note: Specific replies to sendMessage are handled by the temporary
                // messageHandler created within the sendMessage function itself.
            } catch (parseError) {
                console.error("[WebSocket] Error parsing message:", parseError, event.data);
            }
        };
        // --- End WebSocket message listener ---

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

async function imprison(kickWindowStartTime) { // <-- Add kickWindowStartTime parameter
    try {
        // Initial click sequence to open the events panel
        const initialActions = [
            { action: 'click', selector: ".planet__events" },
            { action: 'click', selector: ".planet__events" },
            { action: 'click', selector: ".planet__events" },
        ];
        for (const action of initialActions) {
            await sendMessage(action);
        }

        // First verification: Check if rival is present in the planet
        let rivalCheckResult1 = await actions.checkUsername(config.rival);

        if (rivalCheckResult1) {
            console.log("Rival verified successfully, proceeding with imprisonment");

            // Press Shift+C first
            await sendMessage({ action: 'pressShiftC', selector: ".planet-bar__button__action > img" });
            // Optional small delay if needed after Shift+C before calculating time
            // await actions.sleep(50); // Example small delay

            // --- Calculate dynamic wait ---
            const currentTime = performance.now();
            const elapsedTime = currentTime - kickWindowStartTime;
            
            const remainingWait = Math.max(0, 1000 - elapsedTime);
            console.log(`Elapsed time before final kick actions: ${formatTiming(elapsedTime)}. Remaining wait needed: ${formatTiming(remainingWait)}`);
            // --- End calculation ---

            // Construct the final sequence, adding sleep if needed
            const finalSequenceActions = [];
            if (remainingWait > 0) {
                finalSequenceActions.push({ type: 'sleep', duration: remainingWait });
            }
            finalSequenceActions.push(
                { type: 'click', selector: ".dialog-item-menu__actions__item:last-child > .mdc-list-item__text" },
                // { type: 'click', selector: '.dialog__close-button > img'}, // Keep or remove as needed
                { type: 'xpath', xpath: "//a[contains(.,'Exit')]" }
            );

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
        // Re-throw the original error so executeAttackSequence knows it failed
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
        rivalDetectedViaWebSocket = false; // Reset flag at the start of each loop iteration
        try {
            // Start timing closer to the critical checks
            await actions.waitForClickable('.planet__events'); // Ensure UI is ready

            // --- Prison Check ---
            const prisonCheckStart = performance.now();
            const isInPrison = await checkIfInPrison(config.planetName);
            const prisonCheckDuration = performance.now() - prisonCheckStart;
            // console.log(`Prison check took: ${formatTiming(prisonCheckDuration)}`); // Optional detailed logging
            if (isInPrison) {
                console.log("In prison. Executing auto-release...");
                await autoRelease();
                // await actions.waitForClickable('.planet-bar__button__action > img'); // Wait after release
                 continue; // Restart loop after release
            }

            // --- Check if a RIVAL has been detected via WebSocket BEFORE starting checks ---
            if (!rivalDetectedViaWebSocket) {
                console.log("Rival not detected via WebSocket yet. Waiting...");
               // await actions.sleep(500); // Wait briefly before checking again
                continue; // Skip the rest of the loop and wait for the signal
            }
            console.log("Rival detected via WebSocket. Proceeding with planet/rival checks and potential attack...");
            // --- End RIVAL Check ---


            // --- Critical Rival & Planet Checks ---
            // Removed: const criticalCheckStart = performance.now();

            // 1. Check Planet Name and Online Status (Minimal sleep/wait)
            let planetOk = false;
            try {
                // Reverted back to actions.xpath as waitForClickable timed out
                console.log(`Checking for planet: ${config.planetName}`);
                await actions.xpath(`//span[contains(.,'${config.planetName}')]`);
                console.log(`Checking for 'Online now'`);
                await actions.xpath(`//span[contains(.,'Online now')]`);
                console.log("Clicked 'Online now'. Waiting for list..."); // Log update
                await actions.sleep(150); // *** INCREASED/ADDED: Wait longer after clicking 'Online now' for list to appear ***
                console.log("Planet and Online status confirmed via xpath.");
                planetOk = true;
                // Removed the sleep(150) from here, moved it after 'Online now' click.
            } catch (planetError) {
                 console.log(`Planet/Online check failed via xpath: ${planetError.message}. Retrying next loop.`);
                 await actions.reloadPage();
                 continue; // Skip to next iteration
            }

            // 2. Wait for and Verify Rival Presence using XPath
            let rivalPresent = false;
            let matchedRivalName = null; // Store the name if found
            let rivalVerificationDuration = 0;
            if (planetOk) { // Only check if planet is correct
                const verificationStart = performance.now();
                console.log("Waiting for rival presence using XPath...");
                try {
                    let searchResult = await actions.searchAndClick(config.rival);
					let found = searchResult.matchedRival;
                    rivalVerificationDuration = performance.now() - verificationStart;
                    if (searchResult.flag && found) {
						rivalPresent = true;
                    } else {
						rivalPresent = false;
                        console.log(`No configured rivals found via waitForXPath after checking all. Duration: ${formatTiming(rivalVerificationDuration)}`);
                    }
                } catch (generalError) {
                    // Catch any unexpected errors during the loop/wait process
                    rivalVerificationDuration = performance.now() - verificationStart;
                    console.error(`Error during rival XPath verification: ${generalError.message}. Duration: ${formatTiming(rivalVerificationDuration)}`);
                    rivalPresent = false;
                }
            } else {
                 console.log("Planet check failed, skipping rival verification.");
            }

            // Removed critical check duration calculation and logging

                // Proceed only if click was successful
                if (rivalPresent) {
                    // --- Use currentAttackTime directly as sleep duration ---
                    const sleepDuration = Math.max(0, currentAttackTime); // Ensure sleep is not negative
                    console.log(`Rival found. Using attack time for sleep: ${sleepDuration}ms`);

                    // Execute attack sequence - Pass only sleep duration
                    await executeAttackSequence(sleepDuration);

                    // --- Increment/Reset currentAttackTime AFTER attack attempt ---
                    currentAttackTime += config.interval;
                    console.log(`Incremented attack time by ${config.interval}ms. New time: ${currentAttackTime}ms`);
                    if (currentAttackTime > config.DefenceTime) {
                        currentAttackTime = config.AttackTime; // Reset to base attack time
                        console.log(`Attack time exceeded defense time. Resetting to base: ${currentAttackTime}ms`);
                    }
                    // --- End Increment/Reset ---

            } else {
                 console.log("Rival not found by checkUsername or planet check failed. Skipping attack.");
            }
        } catch (error) {
            console.error(`Error in main loop: ${error.message}. Stack: ${error.stack}`);
            // Consider if handleError should be called or if loop should continue
            // await actions.sleep(2000); // Wait after an error before retrying
			 await actions.reloadPage();
            // await handleError(error); // This might reload the page, potentially losing state
        }
    }
}


// Simplified function: waits for sleep, then attempts imprison
async function executeAttackSequence(sleepDuration) { // Renamed parameter
    try {
        const sequenceStartTime = performance.now(); // Record time BEFORE sleep starts

        // Wait for the calculated sleep duration
        if (sleepDuration > 0) { // Use renamed parameter
            console.log(`Pausing for calculated sleep: ${formatTiming(sleepDuration)}`); // Use renamed parameter
            await actions.sleep(sleepDuration); // Use renamed parameter
            console.log(`Finished sleep.`);
        } else {
            console.log("Calculated sleep duration is zero or negative. Proceeding immediately.");
        }

        // Attempt the imprison action directly, passing the sequence start time
        console.log("Attempting imprison action...");
        await imprison(sequenceStartTime); // <-- Pass the sequence start time recorded before sleep
        console.log("Imprison action successful.");

    } catch (error) {
        // Log error from sleep or imprison
        console.error(`Error during attack sequence (sleep or imprison): ${error.message}`);
        // Re-throw the error so the main loop can handle it (e.g., reload page)
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
