const WebSocket = require('ws');
const puppeteer = require('puppeteer');

const PORT = 8081;
const TIMEOUT = 500;
const SCROLL_POSITION = 288452.8229064941406;

const wss = new WebSocket.Server({ port: PORT });

let browser;
let page;

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

    await configurePage();
    await navigateToGalaxy();
    await injectCSS();
  } catch (error) {
    console.error('Error setting up browser:', error);
  }
}

async function configurePage() {
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

  const client = await page.target().createCDPSession();
  await Promise.all([
    client.send('Network.enable'),
    client.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 0,
      downloadThroughput: 100 * 1024 * 1024 / 8,
      uploadThroughput: 100 * 1024 * 1024 / 8,
    }),
    client.send('Emulation.setCPUThrottlingRate', { rate: 1 }),
  ]);

  await page.setRequestInterception(true);
  page.on('request', (request) => {
    ['font', 'image', 'media'].includes(request.resourceType())
      ? request.abort()
      : request.continue();
  });

  await page.setCacheEnabled(true);
}

async function navigateToGalaxy() {
  await page.goto('https://galaxy.mobstudio.ru/web', { waitUntil: 'networkidle0' });
  console.log('Navigated to galaxy.mobstudio.ru');
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
          this.reloadPage();
        } else {
          throw new Error('Element not found');
        }
      }, frameIndex, selectorType, selector);
      return { status: 'success', action: 'switchToDefaultFrame', message: "Successfully clicked" };
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
    // Ensure rivals is always an array
    const rivalsArray = Array.isArray(rivals) ? rivals : [rivals];

    let result = await Promise.race([
        page.evaluate((selector, rivalsList) => {
            const elements = document.querySelectorAll(selector);
            for (const element of elements) {
                const matchedRival = rivalsList.find(rival => element.textContent.trim() === rival.trim());
                if (matchedRival) {
                    element.click();
                    return { found: true, rival: matchedRival };
                }
            }
            return { found: false };
        }, 'li', rivalsArray),
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