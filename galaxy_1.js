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

// ML Model state using UCB1 Algorithm
class EnhancedMLTimingModel {
    constructor() {
        this.binSize = 5; // 5ms granularity for timing bins
        this.successRatesByTiming = new Map(); // Stores { successes: number, attempts: number } per binned timing
        this.totalAttempts = 0; // Total attempts across all timings
        this.explorationFactor = Math.sqrt(2); // UCB1 exploration constant (C)

        // --- Added for Dynamic Duration Estimation (EMA) ---
        this.emaAlpha = 0.1; // Smoothing factor for EMA
        this.avgPreAttackCheckDuration = 150; // Initial estimate
        this.avgImprisonDuration = 250;       // Initial estimate
        // We don't strictly need counts for EMA, but might be useful for debugging
        // this.preAttackCheckCount = 0;
        // this.imprisonCount = 0;
        // --- End Added ---


        this.loadModel();
    }

    loadModel() {
        try {
            if (fs.existsSync('ml_model_state_ucb.json')) {
                const data = JSON.parse(fs.readFileSync('ml_model_state_ucb.json', 'utf8'));
                // Convert loaded object back to Map
                this.successRatesByTiming = new Map(Object.entries(data.successRatesByTiming || {}));
                this.totalAttempts = data.totalAttempts || 0;

                // --- Load EMA state ---
                this.avgPreAttackCheckDuration = data.avgPreAttackCheckDuration === undefined ? 150 : data.avgPreAttackCheckDuration;
                this.avgImprisonDuration = data.avgImprisonDuration === undefined ? 250 : data.avgImprisonDuration;
                // --- End Load ---

                console.log(`Loaded UCB model state: ${this.successRatesByTiming.size} timing bins, ${this.totalAttempts} total attempts.`);
                console.log(`Loaded Avg Durations: PreAttackCheck=${formatTiming(this.avgPreAttackCheckDuration)}, Imprison=${formatTiming(this.avgImprisonDuration)}`);

            } else {
                 console.log("No existing UCB model state found. Starting fresh.");
                 // Keep initial default estimates if no file exists
            }
        } catch (error) {
            console.error('Error loading UCB ML model:', error);
            // Keep initial default estimates on error
            this.avgPreAttackCheckDuration = 150;
            this.avgImprisonDuration = 250;
        }
    }

    saveModel() {
        try {
            const data = {
                // Convert Map to plain object for JSON serialization
                successRatesByTiming: Object.fromEntries(this.successRatesByTiming),
                totalAttempts: this.totalAttempts,
                // --- Save EMA state ---
                avgPreAttackCheckDuration: this.avgPreAttackCheckDuration,
                avgImprisonDuration: this.avgImprisonDuration
                // --- End Save ---
            };
            fs.writeFileSync('ml_model_state_ucb.json', JSON.stringify(data));
        } catch (error) {
            console.error('Error saving UCB ML model:', error);
        }
    }

    getBinnedTiming(timing) {
        // Ensure timing is a number and not NaN
        const numericTiming = Number(timing);
        if (isNaN(numericTiming)) {
            console.warn(`Invalid timing value received: ${timing}. Defaulting to 0.`);
            return 0;
        }
        return Math.round(numericTiming / this.binSize) * this.binSize;
    }

    predictTiming(attackTime, defenseTime) {
        console.log(`Predicting timing between ${attackTime}ms and ${defenseTime}ms using UCB1`);
        let bestTiming = -1;
        let maxUCB = -Infinity;

        // Ensure attackTime and defenseTime are valid numbers
        const numAttackTime = Number(attackTime);
        const numDefenseTime = Number(defenseTime);
        if (isNaN(numAttackTime) || isNaN(numDefenseTime) || numAttackTime > numDefenseTime) {
             console.error(`Invalid attack/defense time range: ${attackTime}-${defenseTime}. Cannot predict.`);
             // Return a default or central timing as a fallback
             return isNaN(numAttackTime) || isNaN(numDefenseTime) ? 0 : Math.round((numAttackTime + numDefenseTime) / 2);
        }


        // Iterate through possible timing bins in the allowed range
        for (let t = numAttackTime; t <= numDefenseTime; t += this.binSize) {
            const binnedTiming = this.getBinnedTiming(t);
            const stats = this.successRatesByTiming.get(binnedTiming) || { successes: 0, attempts: 0 };

            let ucbValue;
            if (stats.attempts === 0) {
                // If a timing hasn't been tried, prioritize it (infinite UCB)
                ucbValue = Infinity;
            } else {
                const successRate = stats.successes / stats.attempts;
                // UCB1 formula
                const explorationBonus = this.explorationFactor * Math.sqrt(Math.log(this.totalAttempts || 1) / stats.attempts);
                ucbValue = successRate + explorationBonus;
            }

            // console.log(`Timing: ${binnedTiming}ms, SuccessRate: ${(stats.successes / (stats.attempts || 1)).toFixed(2)}, Attempts: ${stats.attempts}, UCB: ${ucbValue.toFixed(3)}`);

            if (ucbValue > maxUCB) {
                maxUCB = ucbValue;
                bestTiming = binnedTiming;
            }
        }

        // Fallback if no timing is selected (should only happen if range is invalid or empty)
        if (bestTiming === -1) {
             console.warn("Could not determine best timing via UCB1. Falling back to midpoint.");
             bestTiming = this.getBinnedTiming(numAttackTime + (numDefenseTime - numAttackTime) / 2);
        }


        console.log(`UCB1 selected timing: ${bestTiming}ms (Max UCB: ${maxUCB === Infinity ? 'Infinity' : maxUCB.toFixed(3)})`);
        return bestTiming;
    }

    recordResult(timing, success, executionTime) {
        // Ensure timing is valid before proceeding
        if (timing === undefined || timing === null || isNaN(Number(timing))) {
             console.error(`Invalid timing received in recordResult: ${timing}. Cannot record.`);
             return;
        }

        const binnedTiming = this.getBinnedTiming(timing);
        const stats = this.successRatesByTiming.get(binnedTiming) || { successes: 0, attempts: 0 };

        stats.attempts++;
        if (success) {
            stats.successes++;
        }
        this.successRatesByTiming.set(binnedTiming, stats);
        this.totalAttempts++; // Increment total attempts for UCB calculation

        this.saveModel(); // Save state after each result

        // Log success rate for this specific timing bin
        const currentSuccessRate = (stats.successes / stats.attempts * 100).toFixed(1);
        console.log(`Recorded result for ${binnedTiming}ms: ${success ? 'Success' : 'Failure'}. New Rate: ${currentSuccessRate}% (${stats.successes}/${stats.attempts}). Total Attempts: ${this.totalAttempts}`);
        // Optional: Log overall success rate if needed
        // console.log(`Overall success rate: ${(this.getOverallSuccessRate() * 100).toFixed(2)}%`);
    }

     // Optional: Calculate overall success rate if needed elsewhere
     getOverallSuccessRate() {
         let totalSuccesses = 0;
         this.successRatesByTiming.forEach(stats => {
             totalSuccesses += stats.successes;
         });
         return this.totalAttempts > 0 ? totalSuccesses / this.totalAttempts : 0;
     }

     // Optional: Estimate latency based on execution time of successful attempts if needed
     getEstimatedLatency() {
         // This requires storing execution times, which we removed for simplicity with UCB1.
         // If needed, executionTime could be added back to the stats object.
         console.warn("getEstimatedLatency is not accurately implemented with the current UCB1 model state.");
         return 0; // Placeholder
     }

    // --- Methods for Updating EMA Durations ---
    updatePreAttackCheckDuration(measuredDuration) {
        if (typeof measuredDuration !== 'number' || isNaN(measuredDuration) || measuredDuration < 0) return;
        // EMA formula: NewAvg = alpha * measurement + (1 - alpha) * OldAvg
        this.avgPreAttackCheckDuration = (this.emaAlpha * measuredDuration) + (1 - this.emaAlpha) * this.avgPreAttackCheckDuration;
        // console.log(`Updated Avg PreAttackCheck Duration: ${formatTiming(this.avgPreAttackCheckDuration)}`); // Optional log
    }

    updateImprisonDuration(measuredDuration) {
        if (typeof measuredDuration !== 'number' || isNaN(measuredDuration) || measuredDuration < 0) return;
        // EMA formula: NewAvg = alpha * measurement + (1 - alpha) * OldAvg
        this.avgImprisonDuration = (this.emaAlpha * measuredDuration) + (1 - this.emaAlpha) * this.avgImprisonDuration;
        // console.log(`Updated Avg Imprison Duration: ${formatTiming(this.avgImprisonDuration)}`); // Optional log
    }
    // --- End EMA Methods ---
}


const mlModel = new EnhancedMLTimingModel();


// Remove estimated durations from static config, they are now dynamic in mlModel
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

        const messageHandler = (event) => {
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
}

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

            // Proceed with imprisonment sequence
            const imprisonSequence = [
                { action: 'pressShiftC', selector: ".planet-bar__button__action > img" },
                { action: 'performSequentialActions', actions: [
                    { type: 'click', selector: ".dialog-item-menu__actions__item:last-child > .mdc-list-item__text" },
                    { type: 'click', selector: '.dialog__close-button > img'},
                    { type: 'xpath', xpath: "//a[contains(.,'Exit')]" }
                ]}
                // Removed sleep and click, replaced with reload below
            ];

            for (const action of imprisonSequence) {
                await sendMessage(action);
            }

            console.log("Imprison actions completed successfully, reloading page...");
            await actions.reloadPage(); // Reload after successful imprison

        } else {
            console.log("Rival verification failed, reloading page...");
            // Safe exit sequence replaced with reload
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

            // --- Critical Rival & Planet Checks ---
            const criticalCheckStart = performance.now(); // Start timing for essential checks

            // 1. Check Planet Name and Online Status (Minimal sleep/wait)
            let planetOk = false;
            try {
                // Reverted back to actions.xpath as waitForClickable timed out
                console.log(`Checking for planet: ${config.planetName}`);
                await actions.xpath(`//span[contains(.,'${config.planetName}')]`);
                console.log(`Checking for 'Online now'`);
                await actions.xpath(`//span[contains(.,'Online now')]`);
                console.log("Clicked 'Online now'. Waiting for list..."); // Log update
                await actions.sleep(300); // *** INCREASED/ADDED: Wait longer after clicking 'Online now' for list to appear ***
                console.log("Planet and Online status confirmed via xpath.");
                planetOk = true;
                // Removed the sleep(150) from here, moved it after 'Online now' click.
            } catch (planetError) {
                 console.log(`Planet/Online check failed via xpath: ${planetError.message}. Retrying next loop.`);
                 await actions.sleep(1000); // Wait longer if planet isn't right before next loop
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
                    // Loop through configured rivals and wait for XPath match
                    for (const rival of config.rival) {
                        const rivalXPath = `//li[contains(., '${rival.trim()}')]`; // XPath to find li containing rival name
                        try {
                            // *** Use the new waitForXPath action which does NOT click ***
                            await actions.waitForXPath({ xpath: rivalXPath }); // Pass xpath as an object property
                            console.log(`waitForXPath succeeded for rival: ${rival}`);
                            rivalPresent = true;
                            matchedRivalName = rival; // Store the matched name
                            break; // Exit loop once a rival is found
                        } catch (waitError) {
                            // Log specific rival failure but continue loop
                            // console.log(`waitForXPath failed for ${rival}: ${waitError.message}`);
                        }
                    }
                    rivalVerificationDuration = performance.now() - verificationStart;
                    if (rivalPresent) {
                        console.log(`Rival '${matchedRivalName}' confirmed present via waitForXPath. Duration: ${formatTiming(rivalVerificationDuration)}`);
                    } else {
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

            // Calculate total critical check duration (Planet + Rival Check)
            // Note: criticalCheckStart was before planet check
            const criticalCheckDuration = performance.now() - criticalCheckStart;
            console.log(`Critical checks (Planet, Rival Check) total took: ${formatTiming(criticalCheckDuration)}`);


            // --- Attack Decision ---
            // Check the rivalPresent flag determined by waitForXPath
            if (rivalPresent) {
                console.log(`Rival '${matchedRivalName}' confirmed present. Proceeding with attack preparation.`); // Updated log

                // *** IMPORTANT: Now click the rival using searchAndClick ***
                // We should re-use searchAndClick here, but *only* if rivalPresent is true.
                // This ensures we click the correct rival just before the attack sequence.
                let clickResult = { flag: false, matchedRival: null };
                try {
                    console.log("Attempting to find and click the confirmed rival...");
                    clickResult = await actions.searchAndClick(config.rival);
                    if (!clickResult.flag) {
                        // This should be rare if checkUsername just succeeded, but handle it.
                        console.warn("searchAndClick failed to find/click the rival immediately after checkUsername succeeded. Aborting attack.");
                        rivalPresent = false; // Prevent attack sequence
                    } else {
                        console.log(`Successfully clicked rival: ${clickResult.matchedRival}`);
                    }
                } catch (clickError) {
                     console.error(`Error during searchAndClick before attack: ${clickError.message}. Aborting attack.`);
                     rivalPresent = false; // Prevent attack sequence
                }

                // Proceed only if click was successful
                if (rivalPresent) {
                    // Get prediction from the UCB1 ML model
                    const predictedTiming = mlModel.predictTiming(
                        config.AttackTime,
                        config.DefenceTime
                    );
                    console.log(`UCB1 ML predicted target timing: ${predictedTiming}ms`);

                    // Calculate the *remaining* delay needed...
                    // The time spent *clicking* the rival should also be accounted for.
                    // Let's stick to the original calculation for simplicity first, using criticalCheckDuration.
                    // Get the *current* dynamic estimates from the ML model
                    const currentAvgPreAttackCheckDuration = mlModel.avgPreAttackCheckDuration;
                    const currentAvgImprisonDuration = mlModel.avgImprisonDuration;
                    const estimatedFinalActionsDuration = currentAvgPreAttackCheckDuration + currentAvgImprisonDuration;

                    const targetSleepEndTime = predictedTiming - estimatedFinalActionsDuration;
                    // Adjust sleep based on time spent *up to the point before sleep starts*.
                    // This now includes planet check, checkUsername, AND searchAndClick.
                    const timeBeforeSleep = performance.now() - criticalCheckStart; // Recalculate time spent just before sleep
                    const adjustedSleepDuration = Math.max(0, targetSleepEndTime - timeBeforeSleep);

                    console.log(`Target Kick Time (Predicted): ${predictedTiming}ms`);
                    console.log(` - Time Before Sleep (Checks + Click): ${formatTiming(timeBeforeSleep)}`); // Updated log
                    console.log(` - Avg Final Actions Duration (Check + Imprison): ${formatTiming(estimatedFinalActionsDuration)} (P:${formatTiming(currentAvgPreAttackCheckDuration)}, I:${formatTiming(currentAvgImprisonDuration)})`);
                    console.log(` = Calculated Sleep Duration: ${formatTiming(adjustedSleepDuration)}`);

                    // Execute attack sequence
                    // Pass the time spent *before* sleep, which now includes the click time.
                    await executeAttackSequence(adjustedSleepDuration, predictedTiming, timeBeforeSleep);
                }

            } else {
                 console.log("Rival not found by checkUsername or planet check failed. Skipping attack.");
                 await actions.sleep(50); // Reduced wait time
            }
        } catch (error) {
            console.error(`Error in main loop: ${error.message}. Stack: ${error.stack}`);
            // Consider if handleError should be called or if loop should continue
             await actions.sleep(2000); // Wait after an error before retrying
            // await handleError(error); // This might reload the page, potentially losing state
        }
    }
}


// Rename parameter checkDuration to timeBeforeSleep
async function executeAttackSequence(adjustedSleepDuration, originalPredictedTiming, timeBeforeSleep) {
    const sequenceStartTime = performance.now(); // Time when this sequence function *starts*

    // Wait for the calculated sleep duration
    let actualSleepDuration = 0;
    if (adjustedSleepDuration > 0) {
        console.log(`Pausing for calculated sleep: ${formatTiming(adjustedSleepDuration)}`);
        const sleepStart = performance.now();
        await actions.sleep(adjustedSleepDuration);
        actualSleepDuration = performance.now() - sleepStart;
        console.log(`Actual sleep duration: ${formatTiming(actualSleepDuration)}`);
    } else {
        console.log("Calculated sleep duration is zero or negative. Proceeding immediately.");
    }

    const sleepEndTime = performance.now();

    // --- ADDED PRE-ATTACK OPPONENT CHECK ---
    let opponentStillPresent = false;
    let actualPreAttackCheckDuration = 0; // Renamed variable
    const preAttackCheckStart = performance.now();
    try {
        console.log(`Re-verifying opponent presence before final kick...`);
        opponentStillPresent = await actions.checkUsername(config.rival); // Use global config
        actualPreAttackCheckDuration = performance.now() - preAttackCheckStart; // Renamed variable
        if (opponentStillPresent) {
            console.log(`Opponent confirmed present after sleep. Proceeding with kick. Pre-attack check took: ${formatTiming(actualPreAttackCheckDuration)}`);
        } else {
            // Use actualSleepDuration calculated earlier
            console.log(`Opponent disappeared during sleep (${formatTiming(actualSleepDuration)}). Aborting kick. Pre-attack check took: ${formatTiming(actualPreAttackCheckDuration)}`);
        }
    } catch (checkError) {
        actualPreAttackCheckDuration = performance.now() - preAttackCheckStart; // Renamed variable
        console.error(`Error during pre-attack opponent check: ${checkError.message}. Aborting kick. Pre-attack check took: ${formatTiming(actualPreAttackCheckDuration)}`);
        opponentStillPresent = false; // Ensure attack is aborted
    }
    // --- END ADDED CHECK ---
    // --- Update EMA for PreAttackCheck ---
    // Update average regardless of whether opponent was present, as the check was performed
    mlModel.updatePreAttackCheckDuration(actualPreAttackCheckDuration);
    // --- End Update ---


    // Execute the kick (imprison) only if opponent is still present
    let success = false;
    const imprisonStartTime = performance.now();
    let actualImprisonDuration = 0; // Renamed variable

    if (opponentStillPresent) { // <-- Check the flag here
        try {
            // Note: searchAndClick already happened in mainLoop.
            // We just need to execute the imprison logic now.
            await imprison(); // Assumes imprison() handles the final steps after rival is clicked
            success = true;
            actualImprisonDuration = performance.now() - imprisonStartTime; // Renamed variable
            console.log(`Successful kick executed. Imprison action took: ${formatTiming(actualImprisonDuration)}`);
            // --- Update EMA for Imprison (only on success/attempt) ---
            mlModel.updateImprisonDuration(actualImprisonDuration);
            // --- End Update ---
        } catch (imprisonError) {
            success = false; // Ensure success is false on error
            actualImprisonDuration = performance.now() - imprisonStartTime; // Renamed variable
            console.error(`Failed kick attempt. Error: ${imprisonError.message}. Imprison action took: ${formatTiming(actualImprisonDuration)}`);
            // Optionally update EMA even on failure, depending on desired behavior
            // mlModel.updateImprisonDuration(actualImprisonDuration);
            // Decide if you want to re-throw the error or just log it and continue the main loop
        }
    } else {
        // If opponent wasn't present, the attack was effectively aborted/failed before imprison started
        success = false;
        actualImprisonDuration = 0; // Imprison action didn't run
        console.log("Kick aborted as opponent was not present before final action.");
        // Attempt to close any potentially open dialog
        try {
            console.log("Attempting to click close button as a cleanup...");
            await actions.click('.dialog__close-button > img'); 
        } catch (closeError) {
            // Log if close fails, but don't stop the process
            console.warn(`Cleanup click on close button failed (likely not present): ${closeError.message}`);
        }
        // Do NOT update imprison EMA here as the action wasn't attempted
    }

    // --- REVISED finally logic (no finally block needed here) ---
    // Calculate total time from critical check start to end of imprison attempt (or abortion)
    // timeBeforeSleep already includes initial checks + the click time
    const totalExecutionTime = timeBeforeSleep + actualSleepDuration + actualPreAttackCheckDuration + actualImprisonDuration;
    // actualKickMoment is time from initial check start to *start* of imprison
    const actualKickMoment = timeBeforeSleep + actualSleepDuration + actualPreAttackCheckDuration;

    // Record the result using the *original* predicted timing bin that was targeted
    mlModel.recordResult(originalPredictedTiming, success, totalExecutionTime);

    // Save the model state (including updated EMAs) after recording result
    mlModel.saveModel(); // Ensure EMAs are saved

    console.log(`--- Attack Sequence Summary ---`);
    console.log(`Target Kick Time (Predicted): ${originalPredictedTiming}ms`);
    console.log(`Time Before Sleep (Checks+Click): ${formatTiming(timeBeforeSleep)}`); // Updated log label
    console.log(`Calculated Sleep:             ${formatTiming(adjustedSleepDuration)}`);
    console.log(`Actual Sleep:                 ${formatTiming(actualSleepDuration)}`);
    console.log(`Pre-Attack Check Duration:    ${formatTiming(actualPreAttackCheckDuration)}`);
    console.log(`Imprison Action Duration:     ${formatTiming(actualImprisonDuration)}`);
    console.log(`---------------------------------`);
    console.log(`Total Execution Time:         ${formatTiming(totalExecutionTime)}`);
    console.log(`Actual Kick Moment Offset:    ${formatTiming(actualKickMoment)} (Time from initial check start to imprison start)`);
    console.log(`Result for Target ${originalPredictedTiming}ms: ${success ? 'Success' : 'Failure'}`);
    console.log(`--- End Summary ---`);
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
