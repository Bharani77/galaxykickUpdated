const { chromium } = require('playwright');
const axios = require('axios');
const WebSocket = require('ws');
const PORT = 8082;
const TIMEOUT = 500;
const SCROLL_POSITION = 288452.8229064941406;
const processedQueries = new Set();
const wss = new WebSocket.Server({ port: PORT });
let cachedStartNickElement = null;
let browser;
let page;

class FrameManager {
  constructor(page) {
    this.page = page;
    this.frameCache = new Map();
    this.elementCache = new Map();
  }

  async getFrame(frameIndex) {
    if (this.frameCache.has(frameIndex)) {
      return this.frameCache.get(frameIndex);
    }

    const frames = await this.page.frames();
    if (frameIndex < frames.length && frameIndex >= 0) {
      const frame = frames[frameIndex];
      this.frameCache.set(frameIndex, frame);
      return frame;
    } else {
      throw new Error(`Frame index ${frameIndex} is out of range.`);
    }
  }

  async getElementLocator(frameIndex, selectorType, selector) {
    const cacheKey = `${frameIndex}:${selectorType}:${selector}`;
    if (this.elementCache.has(cacheKey)) {
      return this.elementCache.get(cacheKey);
    }

    const frame = await this.getFrame(frameIndex);
    let elementLocator;
    if (selectorType === 'xpath') {
      elementLocator = frame.locator(`xpath=${selector}`);
    } else if (selectorType === 'css') {
      elementLocator = frame.locator(selector);
    } else {
      throw new Error(`Unsupported selector type: ${selectorType}`);
    }

    this.elementCache.set(cacheKey, elementLocator);
    return elementLocator;
  }
}

async function setupBrowser() {
  console.log('Launching browser...');
  try {
    /*browser = await puppeteer.launch({
      headless: true,
      defaultViewport: null,
      args: [
        '--no-sandbox',
      ]
    });*/
    browser = await chromium.launch({
      headless: true,
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

    await configurePage();
    await navigateToGalaxy();
    await injectCSS();
  } catch (error) {
    console.error('Error setting up browser:', error);
  }
}

async function configurePage(page) {
  const context = page.context();
  
  // Set realistic viewport
  await page.setViewportSize({
    width: 1920,
    height: 1080
  });

  // Network throttling (more reliable approach)
  await context.route('**/*', async route => {
    const request = route.request();
    const resourceType = request.resourceType();
    
    // Block unnecessary resources
    if (['font', 'image', 'media'].includes(resourceType)) {
      await route.abort();
      return;
    }
    
    // Apply throttling to other requests
    await route.continue({
      throttling: {
        downloadThroughput: 1024 * 1024, // 1 Mbps
        uploadThroughput: 1024 * 1024,
        latency: 100 // ms
      }
    });
  });

  // Enable caching
  await context.setCacheEnabled(true);

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

    return response.data.choices[0].message.content; // Extract the response content
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

  // Wait for the chat message content to be available
  await page.waitForSelector('.channel-message__content__text');

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
      // Evaluate the current state of the chat feed
      const messages = await page.evaluate(() => {
        const messageElements = document.querySelectorAll('.channel-message__content__text div');
        return Array.from(messageElements).map(el => el.textContent.trim()).filter(text => text.length > 0);
      });

      if (messages.length > 0) {
        const latestMessage = messages[messages.length - 1]; // Get the latest message
        console.log('Latest message:', latestMessage);

        // Check if the message starts with /]--BEAST--[
        if (latestMessage.startsWith('`[R]OLE[X]`')) {
          const userQuery = latestMessage.replace('`[R]OLE[X]`', '').trim(); // Extract the user query

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
  const frameManager = new FrameManager(page);
  const element = await frameManager.getElementLocator(frameIndex, selectorType, selector);
  await element.click();
  return { status: 'success', action: 'switchToFrame', message: frameIndex };
},

async switchToFramePlanet({ frameIndex, selectorType, selector }) {
  const frameManager = new FrameManager(page);
  const element = await frameManager.getElementLocator(frameIndex, selectorType, selector);
  await element.click();
  return { status: 'success', action: 'switchToFramePlanet', message: "Successfully clicked and navigated" };
},

async switchToDefaultFrame({ selector }) {
  const frameManager = new FrameManager(page);
  await page.mainFrame();
  const element = await frameManager.getElementLocator(0, 'css', selector);
  await element.click();
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
    if (selector === '.start__user__nick') {
      // Always ensure we have a fresh handle after navigation
      await page.waitForLoadState('networkidle', { timeout: 2000 }).catch(() => {});
      
      // Get fresh element with reduced timeout since we know it exists
      const element = await page.waitForSelector(selector, {
        state: 'attached',
        timeout: 2000
      });
      
      // Click with optimized settings
      await element.click({
        force: true,
        timeout: 1000,
        noWaitAfter: true
      });
    } else {
      // Normal behavior for other selectors
      const element = page.locator(selector).first();
      await element.click();
    }

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


  async searchAndClick({ selector, rivals, timeout = 5000 }) {
  if (!Array.isArray(rivals)) {
    throw new Error('rivals must be an array');
  }

  // Use the Playwright locator to find elements matching the selector
  const locator = page.locator(selector);

  const result = await Promise.race([
    locator.evaluateAll((elements, rivalsArray) => {
      // Loop through each element in the locator and check for an exact match
      for (const element of elements) {
        const matchedRival = rivalsArray.find(rival => element.textContent.trim() === rival.trim());
        if (matchedRival) {
          element.click(); // Click the element if a match is found
          return { found: true, rival: matchedRival };
        }
      }
      return { found: false };
    }, rivals),

    // Timeout function
    new Promise(resolve => setTimeout(() => resolve({ found: false }), timeout))
  ]);

  // If no exact match was found within the timeout, perform alternative action
  if (!result.found) {
    await page.click('.dialog__close-button > img'); // Alternative action
  }

  // Return detailed result of the function execution
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



    // Wait for the function to check if the element is clickable
  async waitForClickable({ selector }) {
  try {
    // Wait for the element to be visible in the DOM
    const locator = page.locator(selector);
    await locator.waitFor({
      state: 'visible',    // Wait for the element to be visible
      timeout: 10000        // Timeout after 3500 ms
    });

    // Check if the element is enabled (clickable)
    const isEnabled = await locator.isEnabled();
    if (!isEnabled) {
      throw new Error(`Element ${selector} is not enabled (clickable).`);
    }

    return { status: 'success', action: 'waitForClickable', selector };
  } catch (error) {
    throw new Error(`Error waiting for clickable element ${selector}: ${error.message}`);
  }
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
  try {
    const element = page.locator(`xpath=${xpath}`);
    await element.click();
    return { status: 'success', action: 'xpath', selector: xpath };
  } catch (error) {
    throw new Error(`Error with XPath ${xpath}: ${error.message}`);
  }
  },

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
        // Create a locator for the given selector
        const locator = page.locator(selector);
		const isSelectorPresent = await locator.count() > 0;

        if (!isSelectorPresent) {
            return {
                status: 'error',
                action: 'checkUsername',
                matches: false,
                message: `Selector not found`
            };
        }
        // Get all text contents from the matched elements using locator
        const elementTexts = await locator.allTextContents();
		
        // If expectedText is an array, check if any rival name matches any element
        if (Array.isArray(expectedText)) {
            const matches = expectedText.some(name => elementTexts.includes(name));
            return {
                status: 'success',
                action: 'checkUsername',
                matches: matches,
                message: matches ? `Found matching rival` : `No matching rival found`
            };
        }

        // If expectedText is a single string, check for exact match
        const matches = elementTexts.includes(expectedText);
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

  ws.on('close', () => console.log('Client disconnected'));
});

console.log(`WebSocket server started on port ${PORT}`);

process.on('SIGINT', async () => {
  if (browser) {
    console.log('Closing browser...');
    await browser.close();
  }
  process.exit();
});
