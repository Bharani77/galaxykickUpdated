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

        this.loadModel();
    }

    loadModel() {
        try {
            if (fs.existsSync('ml_model_state_ucb.json')) {
                const data = JSON.parse(fs.readFileSync('ml_model_state_ucb.json', 'utf8'));
                // Convert loaded object back to Map
                this.successRatesByTiming = new Map(Object.entries(data.successRatesByTiming || {}));
                this.totalAttempts = data.totalAttempts || 0;
                console.log(`Loaded UCB model state: ${this.successRatesByTiming.size} timing bins, ${this.totalAttempts} total attempts.`);
            } else {
                 console.log("No existing UCB model state found. Starting fresh.");
            }
        } catch (error) {
            console.error('Error loading UCB ML model:', error);
        }
    }

    saveModel() {
        try {
            const data = {
                // Convert Map to plain object for JSON serialization
                successRatesByTiming: Object.fromEntries(this.successRatesByTiming),
                totalAttempts: this.totalAttempts
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
}


const mlModel = new EnhancedMLTimingModel();


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
        Object.assign(config, JSON.parse(data));
        config.DefenceTime1 = config.DefenceTime;
        tempTime1 = config.AttackTime;
        
        config.rival = Array.isArray(config.rival) ? config.rival : [config.rival];
        config.rival = config.rival.map(r => r.trim());
        
        console.log('Config updated:', config);
    } catch (err) {
        console.error('Error reading config file:', err);
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
       
        console.log("Auto-release successful");
    } catch (error) {
        console.error("Error in autoRelease:", error);
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
                    { type: 'click', selector: '.dialog__close-button > img' },
                    { type: 'xpath', xpath: "//a[contains(.,'Exit')]" }
                ]},
                { action: 'sleep', ms: 450 },
                { action: 'click', selector: '.start__user__nick' }
            ];

            for (const action of imprisonSequence) {
                await sendMessage(action);
            }
            
            console.log("Imprison actions completed successfully");
            await actions.sleep(100);
        } else {
            console.log("Rival verification failed, safely exiting");
            
            // Safe exit sequence
            const exitSequence = [
                { action: 'performSequentialActions', actions: [
                    { type: 'xpath', xpath: "//a[contains(.,'Exit')]" }
                ]},
                { action: 'sleep', ms: 450 },
                { action: 'click', selector: '.start__user__nick' }
            ];

            for (const action of exitSequence) {
                await sendMessage(action);
            }
        }
    } catch (error) {
        console.error("Error in imprison:", error);
        // Ensure safe exit even in case of error
        try {
            await sendMessage({ 
                action: 'performSequentialActions', 
                actions: [{ type: 'xpath', xpath: "//a[contains(.,'Exit')]" }]
            });
            await actions.sleep(450);
            await actions.click('.start__user__nick');
        } catch (exitError) {
            console.error("Error during safe exit:", exitError);
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
            try {
                const loopStartTime = performance.now();
                await actions.waitForClickable('.planet__events');
                await actions.sleep(50);

                const isInPrison = await checkIfInPrison(config.planetName);
                if (isInPrison) {
                    console.log("In prison. Executing auto-release...");
                    await autoRelease();
                    await actions.waitForClickable('.planet-bar__button__action > img');
                    continue;
                }

                console.log(`New loop iteration started at: ${new Date().toISOString()}`);
                await actions.sleep(50);
                await executeRivalChecks(config.planetName);
                await actions.sleep(300);

                let searchResult = await actions.searchAndClick(config.rival);
                let found = searchResult.matchedRival;
                console.log("Matched Rival flag",found);
				console.log("Matched Rival flag",searchResult.flag);
                if (searchResult.flag && found) {
                    let rivalFoundTime = performance.now();
                    let elapsedTime = rivalFoundTime - loopStartTime;
                    console.log(`Time elapsed since loop start: ${elapsedTime}ms`);
                    
                    // Get prediction from the UCB1 ML model
                    const predictedTiming = mlModel.predictTiming(
                        config.AttackTime,
                        config.DefenceTime // UCB1 doesn't need the 'interval' parameter directly for prediction
                    );

                    // Log timing information
                    console.log(`UCB1 ML predicted timing: ${predictedTiming}ms`);
                    // Note: getEstimatedLatency and getSuccessRate might need adjustment or removal
                    // depending on whether you still need those specific metrics with UCB1.
                    // console.log(`Estimated system latency: ${mlModel.getEstimatedLatency()}ms`); // May be inaccurate now
                    // console.log(`Overall success rate: ${(mlModel.getOverallSuccessRate() * 100).toFixed(2)}%`);

                    // Execute attack with timing measurements
                    await executeAttackSequence(elapsedTime, predictedTiming);
                } else {
                    // Record failed attempt with actual execution time
                    const executionTime = performance.now() - loopStartTime;
                    mlModel.recordResult(config.AttackTime, false, executionTime);
                }
            } catch (error) {
                await handleError(error);
            }
        }
    }


async function executeAttackSequence(elapsedTime, predictedTiming) {
    const startTime = performance.now();
    
    // Wait for the predicted timing
    if (predictedTiming > 0) {
        console.log(`Pausing for ${predictedTiming}ms`);
        await actions.sleep(predictedTiming);
    }
    
    // Execute the kick
    //const rivalCheckStart = performance.now();
    //await executeRivalChecks(config.planetName);
    
    //const searchResult = await actions.searchAndClick(config.rival);
    //const success = searchResult.flag && searchResult.matchedRival;
	//console.log("Success flag result",success);
    
    // --- IMPORTANT ---
    // The success/failure check and recording logic was previously commented out here.
    // It needs to be reinstated and correctly implemented to feed results back to the UCB1 model.
    // We need to determine the 'success' boolean based on the outcome of 'imprison()'.
    // For now, let's assume 'imprison()' throws an error on failure or we can add a check after it.

    let success = false;
    const executionTime = performance.now() - startTime; // Time taken for sleep + imprison attempt
    try {
        await imprison();
        // If imprison() completes without error, assume success
        success = true;
        console.log(`Successful kick executed with timing ${predictedTiming}ms. Execution time: ${formatTiming(executionTime)}`);
    } catch (imprisonError) {
        // If imprison() throws an error, assume failure
        success = false;
        console.error(`Failed kick attempt with timing ${predictedTiming}ms. Error: ${imprisonError.message}. Execution time: ${formatTiming(executionTime)}`);
        // Decide if you want to re-throw the error or just log it and continue the main loop
        // throw imprisonError; // Option: Stop the loop on failure
    } finally {
        // Record the result (success or failure) in the UCB1 model
        mlModel.recordResult(predictedTiming, success, executionTime);
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
