const WebSocket = require('ws');
const fs = require('fs');
const { performance } = require('perf_hooks');
const { exec } = require('child_process');

// Performance monitoring and timing utilities
const getPreciseTime = () => performance.now();

let socket;
let isReconnecting = false;
let flag = 0;
let count = 0;
let tempTime1 = 0;

const performanceMetrics = {
    avgExecutionTime: 0,
    totalExecutions: 0,
    delays: [],
    lastTargetTime: 0
};

let config = {
    RC: '',
    AttackTime: 0,
    DefenceTime: 0,
    DefenceTime1: 0,
    planetName: '',
    interval: 0,
    rival: [],
    timingPrecision: 2000,
    maxAllowedDeviation: 50
};

function loadConfig() {
    try {
        const data = fs.readFileSync('config3.json', 'utf8');
        Object.assign(config, JSON.parse(data));
        config.DefenceTime1 = config.DefenceTime;
        tempTime1 = config.AttackTime;
        
        config.rival = Array.isArray(config.rival) ? config.rival : [config.rival];
        config.rival = config.rival.map(r => r.trim());
        
        console.log('Config loaded:', config);
    } catch (err) {
        console.error('Error reading config:', err);
    }
}

const TimingUtils = {
    sleep: (ms) => new Promise(resolve => {
        const start = getPreciseTime();
        const end = start + ms;
        
        function checkTime() {
            const now = getPreciseTime();
            if (now >= end) {
                resolve();
            } else {
                const remaining = end - now;
                if (remaining > 1) {
                    setTimeout(checkTime, Math.min(remaining, 1));
                } else {
                    setImmediate(checkTime);
                }
            }
        }
        
        checkTime();
    }),

    adjustTiming: (baseTime, drift) => Math.max(0, baseTime - drift)
};

async function handleError(error) {
    console.error("Error occurred:", error);
    try {
        await actions.reloadPage();
    } catch (reloadError) {
        console.error("Reload failed:", reloadError);
        process.exit(1);
    }
}

function setupWebSocket() {
    try {
        socket = new WebSocket('ws://localhost:8082');
        
        socket.onopen = async function() {
            console.log(isReconnecting ? "Reconnected" : "Connected to WebSocket server");
            if (!isReconnecting) {
                await initialConnection();
            }
            isReconnecting = false;
        };

        socket.onclose = function() {
            if (!isReconnecting) {
                console.log("Connection closed");
                handleError("Connection lost");
                process.exit(1);
            }
        };

        socket.onerror = handleError;
    } catch(error) {
        handleError(error);
    }
}

async function sendMessage(message) {
    if (socket.readyState !== WebSocket.OPEN) {
        throw new Error(`WebSocket not ready: ${socket.readyState}`);
    }

    const startTime = getPreciseTime();
    
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error('Response timeout'));
        }, 10000);

        const messageHandler = (event) => {
            const response = JSON.parse(event.data);
            if (response.action !== message.action) return;

            clearTimeout(timeout);
            socket.removeEventListener('message', messageHandler);
            
            const executionTime = getPreciseTime() - startTime;
            performanceMetrics.avgExecutionTime = 
                (performanceMetrics.avgExecutionTime * performanceMetrics.totalExecutions + executionTime) / 
                (performanceMetrics.totalExecutions + 1);
            performanceMetrics.totalExecutions++;
            
            if (response.status === 'success') {
                resolve(response);
            } else {
                reject(new Error(response.message));
            }
        };

        socket.addEventListener('message', messageHandler);
        socket.send(JSON.stringify(message));
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
    xpath: (xpath) => sendMessage({ action: 'xpath', xpath }),
    enterRecoveryCode: (code) => sendMessage({ action: 'enterRecoveryCode', code }),
    sleep: (ms) => TimingUtils.sleep(ms),
    scroll: (selector) => sendMessage({ action: 'scroll', selector }),
    pressShiftC: (selector) => sendMessage({ action: 'pressShiftC', selector }),
    waitForClickable: (selector) => sendMessage({ action: 'waitForClickable', selector }),

    findAndClickByPartialText: async (text) => {
        try {
            let response = await sendMessage({ action: 'findAndClickByPartialText', text });
            if (!response || !('flag' in response)) {
                throw new Error('Invalid response');
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
            console.log("Page reloaded successfully");
        } catch (error) {
            console.error("Reload error:", error);
        } finally {
            isReconnecting = false;
        }
    },

    searchAndClick: async (rivals) => {
        if (!Array.isArray(rivals)) throw new Error('rivals must be array');
        try {
            let response = await sendMessage({ action: 'searchAndClick', rivals });
            if (!response || !('flag' in response) || !('matchedRival' in response)) {
                throw new Error('Invalid response format');
            }
            return response;
        } catch (error) {
            console.error('Error in searchAndClick:', error);
            throw error;
        }
    },

    timedClick: async (selector) => {
        const start = getPreciseTime();
        await actions.click(selector);
        return getPreciseTime() - start;
    },

    enhancedSearchAndClick: (position) => sendMessage({ action: 'enhancedSearchAndClick', position }),
    doubleClick: (selector) => sendMessage({ action: 'doubleClick', selector }),
    performSequentialActions: (actions) => sendMessage({ action: 'performSequentialActions', actions })
};

async function checkIfInPrison(planetName) {
    try {
        const result = await actions.findAndClickByPartialText(planetName);
        if (!result.flag) {
            await actions.waitForClickable('.planet-bar__button__action > img');
            await actions.click('.mdc-button > .mdc-top-app-bar__title');
            return true;
        }
        return false;
    } catch (error) {
        console.error("Prison check error:", error);
        return false;
    }
}

async function autoRelease() {
    try {
        const actionSequence = [
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

        for (const action of actionSequence) {
            await sendMessage(action);
        }
    } catch (error) {
        console.error("Auto-release error:", error);
        throw error;
    }
}

async function imprison() {
    try {
        const actionSequence = [
            { action: 'click', selector: ".planet__events" },
            { action: 'click', selector: ".planet__events" },
            { action: 'click', selector: ".planet__events" },
            { action: 'pressShiftC', selector: ".planet-bar__button__action > img" },
            { action: 'performSequentialActions', actions: [
                { type: 'click', selector: ".dialog-item-menu__actions__item:last-child > .mdc-list-item__text" },
                { type: 'click', selector: '.dialog__close-button > img' },
                { type: 'xpath', xpath: "//a[contains(.,'Exit')]" }
            ]},
            { action: 'sleep', ms: 500 },
            { action: 'click', selector: '.start__user__nick' }
        ];

        for (const action of actionSequence) {
            await sendMessage(action);
        }
        
        await actions.sleep(50);
    } catch (error) {
        console.error("Imprison error:", error);
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
            return false;
        }
        throw error;
    }
}

async function executeAttackSequence(elapsedTime) {
    const startTime = getPreciseTime();
    
    let adjustedAttackTime = Math.max(0, config.AttackTime - elapsedTime);
    const driftCorrection = performanceMetrics.avgExecutionTime > 0 ? 
        Math.min(performanceMetrics.avgExecutionTime, config.maxAllowedDeviation) : 0;
    
    adjustedAttackTime = TimingUtils.adjustTiming(adjustedAttackTime, driftCorrection);
    
    if (adjustedAttackTime > 0) {
        await TimingUtils.sleep(adjustedAttackTime);
    }
    
    const rivalCheckStart = getPreciseTime();
    await executeRivalChecks(config.planetName);
    const searchResult = await actions.searchAndClick(config.rival);
    
    if (searchResult.flag && searchResult.matchedRival) {
        const imprisonStart = getPreciseTime();
        await TimingUtils.sleep(Math.max(0, imprisonStart - rivalCheckStart));
        await imprison();
        
        const totalTime = getPreciseTime() - startTime;
        performanceMetrics.delays.push(totalTime - config.timingPrecision);
        
        flag = 0;
        
        console.log(`Execution time: ${totalTime}ms (Target: ${config.timingPrecision}ms)`);
    } else {
        flag = 1;
        count = 0;
		await actions.sleep(200);
    }
}

async function mainLoop() {
    while (true) {
        try {
            await actions.waitForClickable('.planet__events');
            let loopStartTime = getPreciseTime();

            const isInPrison = await checkIfInPrison(config.planetName);
            if (isInPrison) {
                await autoRelease();
                await actions.waitForClickable('.planet-bar__button__action > img');
                continue;
            }

            await executeRivalChecks(config.planetName);
            let searchResult = await actions.searchAndClick(config.rival);
            
            if (searchResult.flag && searchResult.matchedRival) {
                const elapsedTime = getPreciseTime() - loopStartTime;

                if (config.AttackTime < config.DefenceTime && flag !== 1) {
                    config.AttackTime = tempTime1 + count;
                    count += config.interval;
                    await executeAttackSequence(elapsedTime);
                } else if (config.AttackTime < config.DefenceTime1 && flag === 1) {
                    config.AttackTime = tempTime1 - count;
                    count += config.interval;
                    await executeAttackSequence(elapsedTime);
                } else {
                    config.AttackTime = tempTime1;
                    count = 0;
                    flag = 0;
                    await executeAttackSequence(elapsedTime);
                }
            } else {
                flag = 1;
                count = 0;
				await actions.sleep(200);
            }
        } catch (error) {
            await handleError(error);
        }
    }
}

async function initialConnection() {
    try {
        await actions.sleep(4000);
        await actions.waitForClickable('.mdc-button--black-secondary > .mdc-button__label');
        await actions.click('.mdc-button--black-secondary > .mdc-button__label');
        await actions.enterRecoveryCode(config.RC);
        await actions.click('.mdc-dialog__button:nth-child(2)');
        await mainLoop();
    } catch (error) {
        await handleError(error);
    }
}

// Initialize and start
loadConfig();
setupWebSocket();

// Monitor config changes
fs.watch('config3.json', (eventType) => {
    if (eventType === 'change') {
        console.log('Reloading config...');
        loadConfig();
    }
});