// ==UserScript==
// @name         Galaxy Web Combined Automation Sequence
// @namespace    http://tampermonkey.net/
// @version      1.3
// @description  Automates a sequence of clicks on galaxy.mobstudio.ru/web, handling waits and iframes using XPath, and reports status via window.onPrisonScriptDone.
// @author       Your Name (Merged & Refined by AI)
// @match        https://galaxy.mobstudio.ru/web/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function() {
    'use strict';

    console.log("Galaxy Combined Automation Script: Initializing...");

    // --- Helper Functions ---

    /**
     * Simple delay function.
     * @param {number} ms - Milliseconds to wait.
     * @returns {Promise<void>}
     */
    function delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Waits for an element to exist in the DOM using a CSS selector.
     * @param {string} selector - The CSS selector for the element.
     * @param {Document|Element} [context=document] - The context node to search within.
     * @param {number} [timeout=15000] - Maximum time to wait in milliseconds.
     * @returns {Promise<Element>} - Resolves with the found element.
     * @throws {Error} - Rejects if the element is not found within the timeout.
     */
    function waitForElementCSS(selector, context = document, timeout = 15000) {
        return new Promise((resolve, reject) => {
            const intervalTime = 100; // Check every 100ms
            let elapsedTime = 0;
            const interval = setInterval(() => {
                const element = context.querySelector(selector);
                if (element) {
                    clearInterval(interval);
                    resolve(element);
                } else {
                    elapsedTime += intervalTime;
                    if (elapsedTime >= timeout) {
                        clearInterval(interval);
                        reject(new Error(`CSS Element "${selector}" not found within ${timeout}ms in context ${context.nodeName || 'document'}`));
                    }
                }
            }, intervalTime);
        });
    }

    /**
     * Waits for an element to exist in the DOM using an XPath expression.
     * @param {string} xpath - The XPath expression for the element.
     * @param {Document|Node} [context=document] - The context node to search within.
     * @param {number} [timeout=15000] - Maximum time to wait in milliseconds.
     * @returns {Promise<Node>} - Resolves with the found node (often an Element).
     * @throws {Error} - Rejects if the element is not found or XPath is invalid.
     */
    function waitForElementXPath(xpath, context = document, timeout = 15000) {
        return new Promise((resolve, reject) => {
            const intervalTime = 100; // Check every 100ms
            let elapsedTime = 0;
            const interval = setInterval(() => {
                try {
                    const result = document.evaluate(xpath, context, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                    const element = result.singleNodeValue;

                    if (element) {
                        clearInterval(interval);
                        resolve(element); // Resolve with the found node
                    } else {
                        elapsedTime += intervalTime;
                        if (elapsedTime >= timeout) {
                            clearInterval(interval);
                            reject(new Error(`XPath Element "${xpath}" not found within ${timeout}ms in context ${context.nodeName || 'document'}`));
                        }
                    }
                } catch (error) {
                    clearInterval(interval);
                    reject(new Error(`Error evaluating XPath "${xpath}" in context ${context.nodeName || 'document'}: ${error.message}`));
                }
            }, intervalTime);
        });
    }

    /**
     * Waits for an iframe element based on its index, ensures it's loaded, and returns its document context.
     * @param {number} frameIndex - The zero-based index of the iframe.
     * @param {number} [timeout=15000] - Maximum time to wait in milliseconds.
     * @returns {Promise<{iframeElement: HTMLIFrameElement, frameDocument: Document}>} - Resolves with the iframe element and its document.
     * @throws {Error} - Rejects if the frame is not found, not accessible, or doesn't load.
     */
    function waitForFrameAndGetDocument(frameIndex, timeout = 15000) {
        return new Promise(async (resolve, reject) => {
            const intervalTime = 200;
            let elapsedTime = 0;
            let iframeElement = null;

            console.log(`Attempting to find iframe at index ${frameIndex}...`);

            // First, wait for the iframe tag itself to exist
            try {
                 // Using XPath to find the iframe by index (XPath indexes are 1-based)
                 const iframeXPath = `(//iframe | //frame)[${frameIndex + 1}]`;
                 iframeElement = await waitForElementXPath(iframeXPath, document, timeout);
                 console.log(`Iframe element found at index ${frameIndex}:`, iframeElement);
            } catch (error) {
                 reject(new Error(`Could not find iframe element at index ${frameIndex} within ${timeout}ms. ${error.message}`));
                 return;
            }

            // Now, wait for the frame's content to be accessible and loaded
            const startTime = Date.now();
            const loadInterval = setInterval(() => {
                try {
                    const frameDoc = iframeElement.contentDocument || iframeElement.contentWindow?.document;

                    // Check if document exists and isn't in a loading state
                    if (frameDoc && frameDoc.readyState !== 'loading') {
                         // Extra check: see if body exists (basic readiness indicator)
                        if (frameDoc.body) {
                            clearInterval(loadInterval);
                            console.log(`Iframe index ${frameIndex} content document is accessible and appears loaded.`);
                            resolve({ iframeElement: iframeElement, frameDocument: frameDoc });
                            return;
                        } else {
                             console.log(`Iframe index ${frameIndex} document found, but body not yet available. State: ${frameDoc.readyState}`);
                        }
                    } else if (!frameDoc) {
                         console.log(`Iframe index ${frameIndex} content document not yet accessible.`);
                    } else {
                         console.log(`Iframe index ${frameIndex} content document state: ${frameDoc.readyState}`);
                    }
                } catch (e) {
                    // Cross-origin or other access error
                    clearInterval(loadInterval);
                    reject(new Error(`Cannot access iframe index ${frameIndex} content due to security restrictions or error: ${e.message}`));
                    return;
                }

                // Timeout check for loading phase
                if (Date.now() - startTime > timeout) {
                    clearInterval(loadInterval);
                    reject(new Error(`Timeout waiting for iframe index ${frameIndex} content document to load/become accessible within ${timeout}ms.`));
                }
            }, intervalTime); // Check frame readiness periodically
        });
    }

    // --- Function to get the planet name from storage ---
    async function getPlanetName() {
        // Try to get planet name from window.GM_getValue if available
        try {
            if (typeof window.GM_getValue === 'function') {
                const planetName = await window.GM_getValue('PLANET_NAME', '');
                console.log(`Retrieved planet name from storage: "${planetName}"`);
                return planetName || '';
            } else {
                console.warn('GM_getValue function not available for retrieving planet name');
                return '';
            }
        } catch (error) {
            console.error('Error retrieving planet name:', error);
            return '';
        }
    }

    // --- Main Automation Logic ---
    async function performAutomationSequence() {
        try {
            console.log("Galaxy Combined Automation Script: Starting automation sequence...");
            
            // Get the planet name at the beginning
            const planetName = await getPlanetName();
            console.log(`Using planet name: "${planetName}"`);

            // === Sequence Part 1 (from XPath Mod script) ===
            console.log("--- Part 1 Start ---");

            // 1. Wait for and click the top bar title button (using CSS)
            console.log("Part 1: Waiting for top bar button...");
            const topBarButton = await waitForElementCSS(".mdc-button > .mdc-top-app-bar__title", document);
            console.log("Part 1: Clicking top bar button:", topBarButton);
            topBarButton.click();
           // await delay(500); // Small delay after click

            // 2. Wait for and click the first list item (using CSS)
            console.log("Part 1: Waiting for list item...");
            const listItem = await waitForElementCSS(".-list > .mdc-list-item:nth-child(1) > .mdc-list-item__text", document);
            console.log("Part 1: Clicking list item:", listItem);
            listItem.click();
            await delay(1500); // Wait for potential content load

            // 3. Wait for the specific iframe (index 1) and get its document
            const frameIndex1 = 1; // Second iframe (0-based index)
            console.log(`Part 1: Waiting for iframe index ${frameIndex1} and its document...`);
            const { frameDocument: frameDoc1 } = await waitForFrameAndGetDocument(frameIndex1); // Destructure to get frameDocument
           // await delay(1000); // Allow frame content to settle

            // 4. Wait for and click the element *inside* the iframe using XPath
            const targetXPath1 = "//h1[contains(.,'Diamond Prison Escape')]";
            console.log(`Part 1: Waiting for element inside frame ${frameIndex1} with XPath: ${targetXPath1}`);
            const elementInFrame1 = await waitForElementXPath(targetXPath1, frameDoc1); // Pass frameDoc1 as context
            console.log(`Part 1: Clicking element inside frame ${frameIndex1}:`, elementInFrame1);
            elementInFrame1.click(); // Clicking the found H1 element
            await delay(500); // Delay after click within frame

            console.log("--- Part 1 Completed Successfully ---");


            // === Sequence Part 2 (from Bot Automator script) ===
            // Assumes the previous actions have set up the state for these steps in the main document or a *new* frame context.
            console.log("--- Part 2 Start ---");

            // 5. Click "Yes" paragraph (in the main document)
            console.log("Part 2: Waiting for 'Yes' paragraph (main document)...");
            const targetXPath2 = "//p[contains(.,'Yes')]";
            console.log(`Part 1: Waiting for element inside frame ${frameIndex1} with XPath: ${targetXPath2}`);
            const elementInFrame2 = await waitForElementXPath(targetXPath2, frameDoc1); // Pass frameDoc1 as context
            console.log(`Part 1: Clicking element inside frame ${frameIndex1}:`, elementInFrame2);
            elementInFrame2.click(); // Clicking the found H1 element
            console.log("Part 2: 'Yes' paragraph found, clicking...");


            // 6. Click the image inside the second button (in the main document)
            console.log("Part 2: Waiting for the second button's image (main document)...");
            const secondButtonImg = await waitForElementXPath("//button[2]/img", document);
            console.log("Part 2: Second button image found, clicking...");
            secondButtonImg.click();
            await delay(2000); // Wait for potential frame load/update

            // 7. Wait for the third iframe (index 2) and get its document
            const frameIndex2 = 1; // Third iframe (0-based index)
            console.log(`Part 2: Waiting for iframe index ${frameIndex2} and its document...`);
            const { frameDocument: frameDoc2 } = await waitForFrameAndGetDocument(frameIndex2); // Destructure to get frameDocument
            console.log(`Part 2: Switched context to iframe ${frameIndex2}'s document.`);
            //await delay(2000); // Allow frame content to settle

            // 8. Click "THE_BOT" inside the iframe (index 2) - now using the planet name if available
            const botText = planetName ? planetName : "THE_BOT";
            console.log(`Part 2: Waiting for '${botText}' element inside iframe ${frameIndex2}...`);
            
            // Use the planet name if available, otherwise fall back to "THE_BOT"
            const botXPath = planetName ? 
                `//b[contains(text(),'${planetName}')]` : 
                "//b[contains(.,'THE_BOT')]";
                
            try {
                const botElement = await waitForElementXPath(botXPath, frameDoc2, 5000); // Use frameDoc2 as context, shorter timeout
                console.log(`Part 2: '${botText}' element found, clicking...`);
                botElement.click();
            } catch (error) {
                console.warn(`Could not find element with name '${botText}', falling back to THE_BOT...`);
                // Fallback to THE_BOT if the planet name element wasn't found
                const fallbackBotElement = await waitForElementXPath("//b[contains(.,'THE_BOT')]", frameDoc2);
                console.log("Part 2: Fallback 'THE_BOT' element found, clicking...");
                fallbackBotElement.click();
            }
            await delay(500);

            const frameIndex3 = 2; // Third iframe (0-based index)
            console.log(`Part 2: Waiting for iframe index ${frameIndex3} and its document...`);
            const { frameDocument: frameDoc3 } = await waitForFrameAndGetDocument(frameIndex3); // Destructure to get frameDocument
            console.log(`Part 2: Switched context to iframe ${frameIndex3}'s document.`);

            // 9. Click "Visit Planet" inside the iframe (index 2)
            console.log(`Part 2: Waiting for 'Visit Planet' link inside iframe ${frameIndex3}...`);
            const visitPlanetLink = await waitForElementXPath("//a[contains(text(),'Visit Planet')]", frameDoc3); // Use frameDoc2 as context
            console.log("Part 2: 'Visit Planet' link found, clicking...");
            visitPlanetLink.click();

            console.log("--- Part 2 Completed Successfully ---");
            console.log("Galaxy Combined Automation Script: Full sequence completed successfully.");
            
            // Notify Puppeteer that the script has completed successfully
            if (typeof window.onPrisonScriptDone === 'function') {
                window.onPrisonScriptDone('SUCCESS');
            } else {
                console.error('Puppeteer callback function window.onPrisonScriptDone not found! Cannot report SUCCESS.');
            }
            // Clear the timeout if it was set (though Puppeteer side should handle timeout promise resolution)
            if (window.prisonTimeoutId) {
                clearTimeout(window.prisonTimeoutId);
            }

        } catch (error) {
            console.error("Galaxy Combined Automation Script: An error occurred during the sequence:", error);
            
            // Notify Puppeteer of the error
            if (typeof window.onPrisonScriptDone === 'function') {
                window.onPrisonScriptDone('ERROR: ' + error.message);
            } else {
                console.error('Puppeteer callback function window.onPrisonScriptDone not found! Cannot report ERROR.');
            }
            // Clear the timeout if it was set
            if (window.prisonTimeoutId) {
                clearTimeout(window.prisonTimeoutId);
            }
        }
    }

    // --- Start the automation ---
    // @run-at document-idle ensures the basic DOM is ready.
    // No extra delay needed unless specific dynamic loading *after* idle is known.
    performAutomationSequence();

})();