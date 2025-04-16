const WebSocket = require('ws');
const puppeteer = require('puppeteer');
const axios = require('axios');
const fs = require('fs'); // Added fs module

const PORT = 8080;
const TIMEOUT = 1000; // Increased timeout from 3000ms to 6000ms
const SCROLL_POSITION = 288452.8229064941406;
const processedQueries = new Set();
const wss = new WebSocket.Server({ port: PORT });
// const client = ""; // Removed conflicting declaration

// const TARGET_UID = '57292266'; // No longer needed
let activeWs = null; // Keep track of the active WebSocket connection
let configRivals = []; // To store rival names from config
const RIVAL_DETECTION_COOLDOWN_MS = 5000; // Cooldown period in milliseconds

// Load rivals from config file
try {
    const configData = fs.readFileSync('config1.json', 'utf8');
    const loadedConfig = JSON.parse(configData);
    if (Array.isArray(loadedConfig.rival)) {
        configRivals = loadedConfig.rival.map(r => r.trim()).filter(r => r); // Trim and filter empty strings
    } else if (typeof loadedConfig.rival === 'string' && loadedConfig.rival.trim()) {
        configRivals = [loadedConfig.rival.trim()];
    }
    console.log('Loaded rivals:', configRivals);
} catch (err) {
    console.error('Error reading or parsing config1.json for rivals:', err);
    // Proceed with empty rivals list or handle error as needed
}


let browser;
let page;
let client; // Make client accessible in configurePage scope

async function setupBrowser() {
  console.log('Launching browser...');
  try {
    /*browser = await puppeteer.launch({
      headless: false,
      defaultViewport: null,
      args: [
        '--no-sandbox',
      ]
    });*/
    browser = await puppeteer.launch({
      headless: "new",
      defaultViewport: null,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--no-first-run',
        '--no-zygote',
        '--disable-extensions',
        '--disable-accelerated-2d-canvas',
        '--disable-ipc-flooding-protection',
        '--disable-background-networking',
        '--disable-default-apps',
        '--disable-sync',
        '--disable-translate',
        '--hide-scrollbars',
        '--metrics-recording-only',
        '--mute-audio',
        '--no-default-browser-check',
        '--start-maximized'
      ],
    });
    page = await browser.newPage();
    console.log('New page created');

  await configurePage(client); // Pass client to configurePage
  await navigateToGalaxy();
  await injectCSS();
  } catch (error) {
    console.error('Error setting up browser:', error);
  }
}

// Accept client session as argument
async function configurePage(client) {
  const maxViewport = await page.evaluate(() => ({
    width: window.screen.availWidth,
    height: window.screen.availHeight,
  }));
  await page.setViewport(maxViewport);

  await page.evaluate(() => {
    if (document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen();
    }
  });

  // Expose a function to the page context for signaling back to Node.js
  await page.exposeFunction('onRivalDetect', (rivalName) => {
    console.log(`[Exposed Fn] Detected rival "${rivalName}" via injected script.`);
    if (activeWs && activeWs.readyState === WebSocket.OPEN) {
      try {
        activeWs.send(JSON.stringify({ action: 'rivalDetected', rivalName: rivalName }));
        console.log(`[Exposed Fn] Sent rivalDetected signal for: ${rivalName}`);
      } catch (sendError) {
        console.error(`[Exposed Fn] Error sending rivalDetected signal: ${sendError.message}`);
      }
    } else {
      console.warn(`[Exposed Fn] Rival "${rivalName}" detected, but no active local WebSocket connection.`);
    }
  });

  // Inject script to override WebSocket and listen for messages
  // This runs in the browser context *before* the page's scripts
  const TARGET_WEBSOCKET_URL = 'wss://cs.mobstudio.ru:6672'; // Define the target URL constant
  await page.evaluateOnNewDocument((rivalsToWatch, targetUrl) => {
    const TARGET_COMMANDS = ['JOIN', '353']; // Commands to check within messages

    // Helper function to escape regex special characters
    function escapeRegExp(string) {
        return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // $& means the whole matched string
    }

    // Store original WebSocket
    const NativeWebSocket = window.WebSocket;

    // Override WebSocket constructor
    window.WebSocket = function(url, protocols) {
      console.log('[WS Override] Attempting to connect to:', url);
      const socket = new NativeWebSocket(url, protocols); // Create the actual WebSocket

      // Check if this is the target WebSocket URL
      if (url === targetUrl) {
        console.log('[WS Override] Intercepting target WebSocket:', url);

        socket.addEventListener('message', async (event) => {
          let messageData;
          try {
            // Process message data (handle Blob, ArrayBuffer, string)
            if (event.data instanceof Blob) {
              messageData = await event.data.text();
            } else if (event.data instanceof ArrayBuffer) {
              messageData = new TextDecoder().decode(event.data);
            } else {
              messageData = event.data;
            }

            // Check if message contains target commands
            const hasCommand = TARGET_COMMANDS.some(cmd => messageData.includes(cmd));
            if (!hasCommand) {
              return; // Ignore messages without JOIN or 353
            }

            // Check for each rival
            for (const rival of rivalsToWatch) {
              // Create regex similar to Tampermonkey script to find rival, possibly prefixed with '+'
              const rivalRegex = new RegExp(`(\\+?${escapeRegExp(rival)})`);
              const match = messageData.match(rivalRegex);

              if (match) {
                const detectedName = rival; // The name from our list that was found
                console.log(`[WS Override] RIVAL "${detectedName}" DETECTED in message!`, messageData);
                // Call the exposed function to signal Node.js
                window.onRivalDetect(detectedName);
                // Optional: break if you only need to detect one rival per message
                // break;
              }
            }
          } catch (e) {
            console.error('[WS Override] Error processing message:', e, event.data);
          }
        });

        socket.addEventListener('open', () => {
            console.log('[WS Override] Target WebSocket opened:', url);
        });
        socket.addEventListener('close', () => {
            console.log('[WS Override] Target WebSocket closed:', url);
        });
        socket.addEventListener('error', (err) => {
            console.error('[WS Override] Target WebSocket error:', url, err);
        });
      }

      // Return the original/native WebSocket instance
      return socket;
    };

    // Ensure the override looks like the native one
    window.WebSocket.prototype = NativeWebSocket.prototype;
    window.WebSocket.CONNECTING = NativeWebSocket.CONNECTING;
    window.WebSocket.OPEN = NativeWebSocket.OPEN;
    window.WebSocket.CLOSING = NativeWebSocket.CLOSING;
    window.WebSocket.CLOSED = NativeWebSocket.CLOSED;

  }, configRivals, TARGET_WEBSOCKET_URL); // Pass rivals and target URL to the injected script


  // --- CDP Client Setup (Optional - can be removed if not needed for other things) ---
  // client = await page.target().createCDPSession(); // Keep if needed elsewhere
  // await Promise.all([
  //   // client.send('Network.enable'), // Keep if needed elsewhere
  //   client.send('Network.emulateNetworkConditions', { // Keep if needed
  //     offline: false,
  //     latency: 0,
  //     downloadThroughput: 100 * 1024 * 1024 / 8,
  //     uploadThroughput: 100 * 1024 * 1024 / 8,
  //   }),
  //   client.send('Emulation.setCPUThrottlingRate', { rate: 1 }), // Keep if needed
  // ]);
  // --- End CDP Client Setup ---


  // --- Network Interception (Keep for blocking resources) ---
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    // Keep existing request interception logic (abort specific resource types)
    if (['font', 'image', 'media'].includes(request.resourceType())) {
      request.abort();
    } else {
       // Allow all other requests (including the one with TARGET_UID) to proceed
       request.continue();
    }
  });


  await page.setCacheEnabled(true);
}

async function navigateToGalaxy() {
  await page.goto('https://galaxy.mobstudio.ru/web', { waitUntil: 'networkidle0' });
  console.log('Navigated to galaxy.mobstudio.ru');
}

async function getMistralResponse(userQuery) {
  const apiKey = "WBCXKwMNUV4aogBXd5nNJbERC718YiNi"; // Ensure your API key is set in environment variables
  const apiUrl = 'https://api.mistral.ai/v1/chat/completions'; // Replace with the correct API endpoint if necessary

  try {
    // Prompt for concise response with a limit on length
    const prompt = `Provide a concise response (no more than 2-3 lines) to: "${userQuery}"`;

    const response = await axios.post(apiUrl, {
      model: 'mistral-large-latest', // Adjust the model as necessary
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 20, // Adjust max_tokens to limit the response length
    }, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });

    let rawResponse = response.data.choices[0].message.content.trim();

    // --- Truncate the response ---
    const lines = rawResponse.split('\n');
    let truncatedResponse;
    if (lines.length >= 2) {
      truncatedResponse = lines.slice(0, 2).join('\n'); // Take first two lines
    } else {
      truncatedResponse = rawResponse; // Use the single line if less than 2
    }

    // Further truncate if still too long (e.g., > 100 chars)
    if (truncatedResponse.length > 100) {
      truncatedResponse = truncatedResponse.substring(0, 100) + '...';
    }
    // --- End Truncation ---

    return truncatedResponse;

  } catch (error) {
    console.error('Error fetching response from Mistral:', error);
    return 'Sorry, I could not process your request.';
  }
}

async function injectCSS() {
  const cssContent = await page.evaluate(() => {
    return Array.from(document.styleSheets)
      .flatMap(sheet => {
        try {
          return Array.from(sheet.cssRules).map(rule => rule.cssText);
        } catch (e) {
          console.error('Error accessing stylesheet:', e);
          return [];
        }
      })
      .join('\n');
  });

  await page.evaluate((css) => {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
  }, cssContent);
}

setupBrowser();

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const actions = {
	
  async runAiChat({ username }) {

  // Function to send a message in the input field
  async function sendMessage(response) {
    const inputSelector = '#channel-new-message__text-field-input';
    await page.waitForSelector(inputSelector);
    await page.type(inputSelector, response);
    await page.keyboard.press('Enter');
  }

  // Set an interval to keep checking for new messages
  const checkNewMessages = async () => {
    try {
      // Wait for the chat message container before querying
      await page.waitForSelector('.channel-message__content__text', { timeout: 2000 }); // Wait up to 2s each time

      // Evaluate the current state of the chat feed
      const messages = await page.evaluate(() => {
        const messageElements = document.querySelectorAll('.channel-message__content__text div');
        return Array.from(messageElements).map(el => el.textContent.trim()).filter(text => text.length > 0);
      });

      if (messages.length > 0) {
        const latestMessage = messages[messages.length - 1]; // Get the latest message
        console.log('Latest message:', latestMessage);

        // Check if the message starts with /]--BEAST--[
        if (latestMessage.startsWith(']--BEAST--[')) {
          const userQuery = latestMessage.replace(']--BEAST--[', '').trim(); // Extract the user query

          // Check if the query has already been processed
          if (!processedQueries.has(userQuery)) {
            console.log('New user query:', userQuery);

            // Mark the query as processed
            processedQueries.add(userQuery);

            // Get the response from Mistral API
            const botResponse = await getMistralResponse(userQuery);
            console.log('Bot response:', botResponse);

            // Send the bot response to the chat
            await sendMessage(botResponse);
          } else {
            console.log('Query has already been processed:', userQuery);
          }
        }
      }
    } catch (error) {
      console.log('Error fetching messages:');
    }
  };
  // Set an interval to check for new messages every 2 seconds
  const messageCheckInterval = setInterval(checkNewMessages, 4000);
  return { status: 'success', action: 'runAiChat', message: "Successfully started AiChat" };
},

  async switchToFrame({ frameIndex, selectorType, selector }) {
    const frames = await page.frames();
    console.log('Total frames:', frames.length);
    if (frameIndex <= frames.length && frameIndex >= 0) {
      await page.evaluate((index, selType, sel) => {
        const iframe = document.querySelectorAll('iframe')[index];
        let contentElement;
        if (selType === 'xpath') {
          contentElement = iframe.contentDocument.evaluate(sel, iframe.contentDocument, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
        } else if (selType === 'css') {
          contentElement = iframe.contentDocument.querySelector(sel);
        }
        if (contentElement && contentElement.offsetParent !== null) {
          contentElement.click();
        } else {
          throw new Error('Element not found');
        }
      }, frameIndex, selectorType, selector);
      return { status: 'success', action: 'switchToFrame', message: frameIndex };
    }
    return { status: 'error', action: 'switchToFrame', message: 'Frame index out of range' };
  },

  async switchToFramePlanet({ frameIndex, selectorType, selector }) {
    await page.mainFrame();
    const frames = await page.frames();
    if (frameIndex <= frames.length && frameIndex >= 0) {
      await page.evaluate((index, selType, sel) => {
        const iframe = document.querySelectorAll('iframe')[index];
        let contentElement;
        if (selType === 'xpath') {
          contentElement = iframe.contentDocument.evaluate(sel, iframe.contentDocument, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
        } else if (selType === 'css') {
          contentElement = iframe.contentDocument.querySelector(sel);
        }
        if (contentElement) {
          contentElement.click();
          // Reload logic moved outside evaluate
        } else {
          throw new Error('Element not found');
        }
      }, frameIndex, selectorType, selector);

      // Reload the page after clicking the element in the frame
      await this.reloadPage(); // Call reloadPage from Node.js context

      // Restore original return, but correct the action name
      return { status: 'success', action: 'switchToFramePlanet', message: "Successfully clicked and reloaded" };
    } else {
       return { status: 'error', action: 'switchToFramePlanet', message: 'Frame index out of range' };
    }
  },

  async switchToDefaultFrame({ selector }) {
    await page.mainFrame();
    await page.evaluate((sel) => {
      const element = document.querySelector(sel);
      if (element) {
        element.click();
      }
      return { success: false, message: 'Element not found' };
    }, selector);
    return { status: 'success', action: 'switchToDefaultFrame', message: "Successfully clicked" };
  },

  async doubleClick({ selector }) {
    try {
      await page.waitForSelector(selector, { timeout: TIMEOUT });
      await page.evaluate((sel) => {
        const element = document.querySelector(sel);
        if (element) {
          const event = new MouseEvent('dblclick', {
            'view': window,
            'bubbles': true,
            'cancelable': true
          });
          element.dispatchEvent(event);
        } else {
          throw new Error(`Element not found: ${sel}`);
        }
      }, selector);
      return { status: 'success', action: 'doubleClick', selector };
    } catch (error) {
      throw new Error(`Error double-clicking element ${selector}: ${error.message}`);
    }
  },

  async click({ selector }) {
    try {
      await page.waitForSelector(selector, { timeout: TIMEOUT });
      await page.click(selector);
      return { status: 'success', action: 'click', selector };
    } catch (error) {
      throw new Error(`Error with element ${selector}: ${error.message}`);
    }
  },

  async enhancedSearchAndClick({ position }) {
    try {
      await page.waitForSelector('li', { timeout: TIMEOUT });
      const result = await page.evaluate((pos) => {
        const elements = document.querySelectorAll('li');
        if (elements.length === 0) return { found: false };

        let elementToClick;
        if (pos === 'second' && elements.length >= 2) {
          elementToClick = elements[2];
        } else if (pos === 'last') {
          elementToClick = elements[elements.length - 1];
        } else {
          return { found: false };
        }

        elementToClick.click();
        return { 
          found: true, 
          text: elementToClick.textContent.trim(),
          position: pos
        };
      }, position);

      if (!result.found) {
        await page.click('.dialog__close-button > img');
      }

      return {
        status: 'success',
        action: 'enhancedSearchAndClick',
        message: result.found 
          ? `Clicked ${result.position} element with text: ${result.text}` 
          : `No ${position} element found, clicked alternative button`,
        flag: result.found,
        clickedText: result.text || "N/A",
        position: result.position
      };
    } catch (error) {
      throw new Error(`Error in enhancedSearchAndClick: ${error.message}`);
    }
  },


async searchAndClick({ rivals }) {
    if (!Array.isArray(rivals)) {
      throw new Error('rivals must be an array');
    }

    let result = await Promise.race([
      page.evaluate((selector, rivalsArray) => {
        const elements = document.querySelectorAll(selector);
        for (const element of elements) {
          const matchedRival = rivalsArray.find(rival => element.textContent.trim() === rival.trim());
          if (matchedRival) {
            element.click();
            return { found: true, rival: matchedRival };
          }
        }
        return { found: false };
      }, 'li', rivals),
      sleep(TIMEOUT).then(() => ({ found: false }))
    ]);

    if (!result.found) {
      await page.click('.dialog__close-button > img');
    }

    return {
      status: 'success',
      action: 'searchAndClick',
      message: result.found ? `Found and clicked exact matching element for rival: ${result.rival}` : 'No exact match found, clicked alternative button',
      flag: result.found,
      matchedRival: result.rival || "dummyvalue"
    };
  },


  async scroll({ selector }) {
    await page.waitForSelector(selector, { timeout: TIMEOUT });
    await page.evaluate((sel, pos) => {
      const element = document.querySelector(sel);
      if (element) element.scrollTop = pos;
      else throw new Error(`Element not found: ${sel}`);
    }, selector, SCROLL_POSITION);
    return { status: 'success', action: 'scroll', selector, position: SCROLL_POSITION };
  },

  async waitForClickable({ selector }) {
    await page.waitForFunction(
      (sel) => {
        const element = document.querySelector(sel);
        if (!element) return false;
        const style = window.getComputedStyle(element);
        return element.offsetParent !== null &&
              !element.disabled &&
              style.visibility !== 'hidden' &&
              style.display !== 'none' &&
              style.opacity !== '0';
      },
      { timeout: 3500 },
      selector
    );
    return { status: 'success', action: 'waitForClickable', selector };
  },



  async findAndClickByPartialText({ text }) {
    const xpathExpression = `//span[contains(text(), "${text}")]`;
    const clickResult = await page.evaluate((xpath) => {
      const element = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
      if (element) {
        // element.click(); // Uncomment if you want to click the element
        return { success: true, message: 'Element found', flag: true };
      } else {
        return { success: false, message: 'Element not found', flag: false };
      }
    }, xpathExpression);
    
    return { 
      status: 'success', 
      action: 'findAndClickByPartialText', 
      selector: xpathExpression, 
      flag: clickResult.flag
    };
  },

  async xpath({ xpath }) {
    const clickResult = await page.evaluate((xpathExpression) => {
      const element = document.evaluate(xpathExpression, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
      if (element) {
        element.click();
        return { success: true, message: 'Element clicked successfully' };
      }
      return { success: false, message: 'Element not found' };
    }, xpath);

    if (!clickResult.success) {
      throw new Error(clickResult.message);
    }
    return { status: 'success', action: 'xpath', selector: xpath };
  },

  // *** NEW ACTION: Waits for XPath without clicking ***
  async waitForXPath({ xpath }) {
    try {
      // Use Puppeteer's built-in waitForXPath
      await page.waitForXPath(xpath, { timeout: TIMEOUT }); // Use the standard TIMEOUT
      return { status: 'success', action: 'waitForXPath', selector: xpath, message: 'XPath element found' };
    } catch (error) {
      // Throw an error if the element is not found within the timeout
      throw new Error(`Element for XPath not found within timeout: ${xpath} - ${error.message}`);
    }
  },
  // *** END NEW ACTION ***

  async sleep({ ms }) {
    await sleep(ms);
    return { status: 'success', action: 'sleep', ms };
  },

  async performSequentialActions({ actions }) {
    console.log("Received actions to perform:", actions);
    if (!Array.isArray(actions)) {
      throw new Error("actions must be an array");
    }

    for (const action of actions) {
      console.log("Performing action:", action);
      switch (action.type) {
        case 'sleep':
          await sleep(action.duration);
          break;
        case 'click':
          await page.waitForSelector(action.selector, { timeout: TIMEOUT });
          await page.click(action.selector);
          break;
        case 'xpath':
          const clickResult = await page.evaluate((xpathExpression) => {
            const element = document.evaluate(xpathExpression, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
            if (element) {
              element.click();
              return { success: true, message: 'Element clicked successfully' };
            }
            return { success: false, message: 'Element not found' };
          }, action.xpath);
          
          if (!clickResult.success) {
            throw new Error(`XPath element not found or couldn't be clicked: ${action.xpath}`);
          }
          break;
        default:
          throw new Error(`Unknown action type: ${action.type}`);
      }
    }
    return { status: 'success', action: 'performSequentialActions', message: 'All actions completed' };
  },
  async checkUsername({ selector, expectedText }) {
		try {
			const matches = await page.evaluate((sel, expected) => {
				const elements = document.querySelectorAll(sel);
				// Convert elements to array
				const elementTexts = Array.from(elements).map(el => el.textContent);
				
				// If expectedText is array, check if any rival name matches any element
				if (Array.isArray(expected)) {
					return expected.some(name => elementTexts.includes(name));
				}
				// If single string, check for exact match
				return elementTexts.includes(expected);
				
			}, selector, expectedText);

			return {
				status: 'success',
				action: 'checkUsername',
				matches: matches,
				message: matches ? `Found matching rival` : `No matching rival found`
			};
		} catch (error) {
			throw new Error(`Error checking username: ${error.message}`);
		}
	},

  async enterRecoveryCode({ code }) {
    await page.waitForSelector('input[name="recoveryCode"]', { timeout: 10000 });
    await page.evaluate((rc) => {
      document.querySelector('input[name="recoveryCode"]').value = rc;
    }, code);
    return { status: 'success', action: 'enterRecoveryCode', code };
  },

  async reloadPage() {
    await page.reload({ waitUntil: 'networkidle0' });
    return { status: 'success', action: 'reloadPage', message: 'Page reloaded successfully' };
  },

  async pressShiftC({ selector }) {
    await page.waitForSelector(selector, { timeout: TIMEOUT });
    await page.focus(selector);
    await page.keyboard.down('Shift');
    await page.keyboard.press('C');
    await page.keyboard.up('Shift');
    return { status: 'success', action: 'pressShiftC', selector };
  }
};

wss.on('connection', function connection(ws) {
  console.log('Client connected');
  activeWs = ws; // Store the latest connection

  ws.on('message', async function incoming(message) {
    console.log('Received:', message.toString());
    let data;
    try {
      data = JSON.parse(message);
    } catch (error) {
      console.error('Error parsing message:', error);
      ws.send(JSON.stringify({ status: 'error', message: 'Invalid JSON' }));
      return;
    }

    if (!actions[data.action]) {
      ws.send(JSON.stringify({ status: 'error', message: `Unknown action: ${data.action}` }));
      return;
    }

    try {
      const result = await actions[data.action](data);
      ws.send(JSON.stringify(result));
    } catch (error) {
      console.error(`Error in ${data.action}:`, error);
      ws.send(JSON.stringify({ status: 'error', action: data.action, message: error.message }));
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected');
    if (activeWs === ws) {
      activeWs = null; // Clear activeWs if this connection closes
    }
  });

  ws.on('error', (error) => {
     console.error('WebSocket error:', error);
     if (activeWs === ws) {
       activeWs = null; // Clear on error too
     }
  });
});

console.log(`WebSocket server started on port ${PORT}`);

process.on('SIGINT', async () => {
  if (browser) {
    console.log('Closing browser...');
    await browser.close();
  }
  process.exit();
});
