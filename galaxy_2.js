const WebSocket = require('ws');
const fs = require('fs');
const { exec } = require('child_process');

let socket;
let isReconnecting = false;
let flag = 0;
let count = 0;
let tempTime1 = 0;

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

fs.watch('config.json', (eventType) => {
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
            await waitForAllElements();
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
            { action: 'sleep', ms: 250 },
            { action: 'click', selector: '.start__user__nick' }
        ];

        for (const action of actionss) {
            await sendMessage(action);
        }

        console.log("Imprison actions completed successfully");
        await actions.sleep(50);
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
            await actions.waitForClickable('.planet__events');
            let loopStartTime = Date.now();
            await actions.sleep(50);

            const isInPrison = await checkIfInPrison(config.planetName);
            if (isInPrison) {
                console.log("In prison. Executing auto-release...");
                await autoRelease();
                await actions.waitForClickable('.planet-bar__button__action > img');
                loopStartTime = Date.now();
                continue;
            }

            console.log(`New loop iteration started at: ${loopStartTime}`);
            await actions.sleep(50);
            await executeRivalChecks(config.planetName);
            await actions.sleep(100);

            let searchResult = await actions.searchAndClick(config.rival);
            let found = searchResult.matchedRival;
            
            if (searchResult.flag && found) {
                let rivalFoundTime = Date.now();
                let elapsedTime = rivalFoundTime - loopStartTime;
                console.log(`Time elapsed since loop start: ${elapsedTime}ms`);

                if (config.AttackTime < config.DefenceTime && flag !== 1) {
                    await handleAttack(elapsedTime);
                } else if (config.AttackTime < config.DefenceTime1 && flag === 1) {
                    await handleDefense(elapsedTime);
                } else {
                    await handleReset(elapsedTime);
                }
            } else {
                console.log("No rival found");
                flag = 1;
                count = 0;
                found = false;
            }

            console.log("Loop iteration complete. AttackTime:", config.AttackTime);
        } catch (error) {
            await handleError(error);
        }
    }
}

async function handleAttack(elapsedTime) {
    config.AttackTime = tempTime1 + count;
    count += config.interval;
    config.AttackTime -= 75;
    console.log("count: " + count);
    console.log("Current Attack Time: " + config.AttackTime);
    
    await executeAttackSequence(elapsedTime);
}

async function handleDefense(elapsedTime) {
    config.AttackTime = tempTime1 - count;
    count += config.interval;
    config.AttackTime -= 75;
    
    await executeAttackSequence(elapsedTime);
}

async function handleReset(elapsedTime) {
    console.log("Reset condition triggered");
    config.AttackTime = tempTime1;
    count = 0;
    flag = 0;
    
    await executeAttackSequence(elapsedTime);
}

async function executeAttackSequence(elapsedTime) {
    let adjustedAttackTime = Math.max(0, config.AttackTime - elapsedTime);
    console.log(`Adjusted AttackTime: ${adjustedAttackTime}ms`);
    
    if (adjustedAttackTime > 0) {
        await actions.sleep(adjustedAttackTime);
    }
    
    await executeRivalChecks(config.planetName);
    const rivalsToSearch = Array.isArray(config.rival) ? config.rival : [config.rival];
    let searchResult = await actions.searchAndClick(rivalsToSearch);
    let found = searchResult.matchedRival;
    if (searchResult.flag && found) {
        console.log("Rival still present");
        await actions.sleep(75);
        await imprison();
        config.AttackTime += 75;
        flag = 0;
        found = false;
    } else {
        console.log("No rival found");
        flag = 1;
        count = 0;
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
        await mainLoop();
    } catch (error) {
        await handleError(error);
    }
}

setupWebSocket();