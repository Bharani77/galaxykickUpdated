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

// ML Model state
class EnhancedMLTimingModel {
    constructor() {
        this.successfulTimings = [];
        this.failedTimings = [];
        this.maxHistorySize = 100;
        this.binSize = 5; // 5ms granularity for more precise timing
        this.successRatesByTiming = new Map();
        this.recentResults = []; // Store recent results for adaptive learning
        this.maxRecentSize = 20;
        
        // Parameters for weighted moving average
        this.alpha = 0.3; // Weight for new observations
        this.currentEstimate = null;
        
        this.loadModel();
    }

    loadModel() {
        try {
            if (fs.existsSync('ml_model_state.json')) {
                const data = JSON.parse(fs.readFileSync('ml_model_state.json', 'utf8'));
                this.successfulTimings = data.successfulTimings || [];
                this.failedTimings = data.failedTimings || [];
                this.successRatesByTiming = new Map(Object.entries(data.successRatesByTiming || {}));
                this.recentResults = data.recentResults || [];
                this.currentEstimate = data.currentEstimate;
            }
        } catch (error) {
            console.error('Error loading ML model:', error);
        }
    }

    saveModel() {
        try {
            const data = {
                successfulTimings: this.successfulTimings,
                failedTimings: this.failedTimings,
                successRatesByTiming: Object.fromEntries(this.successRatesByTiming),
                recentResults: this.recentResults,
                currentEstimate: this.currentEstimate
            };
            fs.writeFileSync('ml_model_state.json', JSON.stringify(data));
        } catch (error) {
            console.error('Error saving ML model:', error);
        }
    }
	
	getEstimatedLatency() {
        // Calculate average latency from recent successful results
        const recentSuccesses = this.recentResults
            .filter(result => result.success)
            .map(result => result.executionTime);
        
        if (recentSuccesses.length === 0) return 0;
        
        return recentSuccesses.reduce((sum, time) => sum + time, 0) / recentSuccesses.length;
    }

    getBinnedTiming(timing) {
        return Math.round(timing / this.binSize) * this.binSize;
    }

    updateSuccessRate(timing, success) {
        const binnedTiming = this.getBinnedTiming(timing);
        const current = this.successRatesByTiming.get(binnedTiming) || { successes: 0, attempts: 0 };
        current.attempts++;
        if (success) current.successes++;
        this.successRatesByTiming.set(binnedTiming, current);
    }

    findBestTimingInRange(attackTime, defenseTime) {
        const validTimings = [];
        
        // Create ranges of timings to test
        for (let timing = attackTime; timing <= defenseTime; timing += this.binSize) {
            const binnedTiming = this.getBinnedTiming(timing);
            const stats = this.successRatesByTiming.get(binnedTiming) || { successes: 0, attempts: 0 };
            
            if (stats.attempts > 0) {
                const successRate = stats.successes / stats.attempts;
                const confidence = 1 - (1 / Math.sqrt(stats.attempts + 1));
                const score = successRate * confidence;
                
                validTimings.push({
                    timing: binnedTiming,
                    score,
                    successRate,
                    attempts: stats.attempts
                });
            }
        }

        // Sort by score and get the best timing
        validTimings.sort((a, b) => b.score - a.score);
        return validTimings[0]?.timing;
    }

    getAdaptiveTiming(attackTime, defenseTime) {
        const range = defenseTime - attackTime;
        const midPoint = attackTime + (range / 2);
        
        // If we have recent successful results, use them to adjust the timing
        if (this.recentResults.length > 0) {
            const recentSuccesses = this.recentResults
                .filter(result => result.success)
                .map(result => result.timing);
            
            if (recentSuccesses.length > 0) {
                // Calculate weighted average of recent successful timings
                const weights = recentSuccesses.map((_, i) => 
                    Math.exp(-i / recentSuccesses.length));
                const totalWeight = weights.reduce((a, b) => a + b, 0);
                
                const weightedSum = recentSuccesses.reduce((sum, timing, i) => 
                    sum + (timing * weights[i]), 0);
                
                return weightedSum / totalWeight;
            }
        }
        
        // If no recent successes, start from the middle and gradually explore
        return midPoint;
    }

    predictTiming(attackTime, defenseTime) {
        console.log(`Predicting timing between ${attackTime}ms and ${defenseTime}ms`);
        
        // First, check if we have a good timing from historical data
        const bestHistoricalTiming = this.findBestTimingInRange(attackTime, defenseTime);
        
        // Get adaptive timing based on recent results
        const adaptiveTiming = this.getAdaptiveTiming(attackTime, defenseTime);
        
        // If we have a good historical timing, use it most of the time
        if (bestHistoricalTiming && Math.random() < 0.7) {
            console.log(`Using historical best timing: ${bestHistoricalTiming}ms`);
            return bestHistoricalTiming;
        }
        
        // Use adaptive timing with small random adjustment
        const range = defenseTime - attackTime;
        const randomAdjustment = (Math.random() - 0.5) * (range * 0.1); // ±5% of range
        const finalTiming = Math.min(defenseTime, 
                                   Math.max(attackTime, 
                                          adaptiveTiming + randomAdjustment));
        
        console.log(`Using adaptive timing: ${finalTiming}ms`);
        return finalTiming;
    }

    recordResult(timing, success, executionTime) {
        const binnedTiming = this.getBinnedTiming(timing);
        
        // Update success rates
        this.updateSuccessRate(binnedTiming, success);
        
        // Update timing history
        if (success) {
            this.successfulTimings.push(binnedTiming);
            if (this.successfulTimings.length > this.maxHistorySize) {
                this.successfulTimings.shift();
            }
        } else {
            this.failedTimings.push(binnedTiming);
            if (this.failedTimings.length > this.maxHistorySize) {
                this.failedTimings.shift();
            }
        }

        // Update recent results
        this.recentResults.push({ timing: binnedTiming, success, executionTime });
        if (this.recentResults.length > this.maxRecentSize) {
            this.recentResults.shift();
        }

        // Update weighted moving average estimate
        if (success) {
            if (this.currentEstimate === null) {
                this.currentEstimate = timing;
            } else {
                this.currentEstimate = (this.alpha * timing) + 
                                     ((1 - this.alpha) * this.currentEstimate);
            }
        }

        this.saveModel();
        
        // Log success rate for this timing
        const stats = this.successRatesByTiming.get(binnedTiming);
        const successRate = stats ? (stats.successes / stats.attempts * 100).toFixed(1) : 0;
        console.log(`Timing ${binnedTiming}ms - Success Rate: ${successRate}%`);
    }

    getSuccessRate() {
        const totalAttempts = this.successfulTimings.length + this.failedTimings.length;
        return totalAttempts > 0 ? this.successfulTimings.length / totalAttempts : 0;
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
        const data = fs.readFileSync('config2.json', 'utf8');
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

fs.watch('config2.json', (eventType) => {
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
        socket = new WebSocket('ws://localhost:8081');

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
        const actionss = [
            { action: 'click', selector: ".planet__events" },
            { action: 'click', selector: ".planet__events" },
            { action: 'click', selector: ".planet__events" },
            { action: 'pressShiftC', selector: ".planet-bar__button__action > img" },
            { action: 'performSequentialActions', actions: [
                { type: 'click', selector: ".dialog-item-menu__actions__item:last-child > .mdc-list-item__text" },
                { type: 'click', selector: '.dialog__close-button > img' },
                { type: 'xpath', xpath: "//a[contains(.,'Exit')]" }
            ]},
            { action: 'sleep', ms: 450 },
            { action: 'click', selector: '.start__user__nick' }
        ];

        for (const action of actionss) {
            await sendMessage(action);
        }

        console.log("Imprison actions completed successfully");
        await actions.sleep(100);
    } catch (error) {
        console.error("Error in imprison:", error);
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
                    
                    // Get prediction from enhanced ML model
                    const predictedTiming = mlModel.predictTiming(
                        config.AttackTime,
                        config.DefenceTime,
                        config.interval
                    );
                    
                    // Log enhanced timing information
                    console.log(`ML predicted timing: ${predictedTiming}ms`);
                    console.log(`Estimated system latency: ${mlModel.getEstimatedLatency()}ms`);
                    console.log(`Recent success rate: ${(mlModel.getSuccessRate() * 100).toFixed(2)}%`);
                    
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
    
    // Record the result
    //const executionTime = performance.now() - startTime;
    //mlModel.recordResult(predictedTiming, success, executionTime);
    
    //if (success) {
        await imprison();
        console.log(`Successful kick with timing ${predictedTiming}ms`);
    //} else {
    //    console.log(`Failed kick with timing ${predictedTiming}ms`);
    //}
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
		await actions.runAiChat("[L][E][0]"); //change
        await mainLoop();
    } catch (error) {
        await handleError(error);
    }
}

setupWebSocket();
