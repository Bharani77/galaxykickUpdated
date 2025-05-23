// ==UserScript==
// @name         Galaxy Web Combined Automation Sequence
// @namespace    http://tampermonkey.net/
// @version      1.4
// @description  Automates a sequence of clicks on galaxy.mobstudio.ru/web, handling waits and iframes using XPath.
// @author       Your Name (Merged & Refined by AI)
// @match        https://galaxy.mobstudio.ru/web/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==
(function() {
    'use strict';

    console.log("Galaxy Combined Automation Script: Initializing...");

    // --- Settings from main script ---
    let recoveryCode = "";
    let planetName = "";
    let isFirstTimeInPrison = true; // Flag to track if this is the first prison visit

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

    
    // --- Function to get data from window.PRISON_AUTOMATION_DATA ---
    async function getAutomationData() {
        try {
            // Wait for data to be available
            
            const data = JSON.parse(localStorage.getItem('PRISON_AUTOMATION_DATA') || '{}');
			recoveryCode = data.recoveryCode || "";
			planetName = data.planetName || "";
            
            console.log(`Retrieved data from window.PRISON_AUTOMATION_DATA:`);
            console.log(`- planetName: "${planetName}"`);
            
            // Log redacted recovery code for security
            if (recoveryCode) {
                const maskedCode = recoveryCode.substring(0, 2) + 
                                  "*".repeat(Math.max(0, recoveryCode.length - 4)) + 
                                  recoveryCode.substring(recoveryCode.length - 2);
                console.log(`- recoveryCode: "${maskedCode}"`);
            } else {
                console.log(`- recoveryCode: not available`);
            }
            
            // Check if we've been here before by looking for a session flag
            const isPrisonVisited = localStorage.getItem('prisonVisited') === 'true';
            if (isPrisonVisited) {
                isFirstTimeInPrison = false;
                console.log("Not first time in prison - will need to refresh browser first");
            } else {
                localStorage.setItem('prisonVisited', 'true');
                console.log("First time in prison - no refresh needed");
            }
            
        } catch (error) {
            console.error('Error retrieving automation data:', error);
        }
    }
    
    // --- Browser refresh function ---
    async function refreshBrowserAndContinue() {
        console.log("Refreshing browser before prison automation...");
        location.reload();
        // The script will be reloaded, so we'll continue from the beginning
        return new Promise(() => {}); // Never resolves since we're reloading
    }

    // --- Main Automation Logic ---
    async function performAutomationSequence() {
        try {
            console.log("Galaxy Combined Automation Script: Starting automation sequence...");

            // Get the automation data (recoveryCode and planetName)
            await getAutomationData();
            
            // If not first time in prison, refresh the browser first
            if (!isFirstTimeInPrison) {
                console.log("Not first time in prison - refreshing browser");
                //await refreshBrowserAndContinue();
                //return; // We won't get here - browser will refresh
            }

            // Skip login if not needed (after refresh)
            let needsLogin = localStorage.getItem('skipLoginAfterRefresh') !== 'true';
            if (!needsLogin) {
                console.log("Skipping login steps after refresh");
                localStorage.removeItem('skipLoginAfterRefresh'); // Reset for next time
            } else if (isFirstTimeInPrison) {
                // Set flag to skip login if we refresh
                localStorage.setItem('skipLoginAfterRefresh', 'true');
                
                // Only proceed with login if recovery code is available
                if (!recoveryCode) {
                    console.error("Cannot proceed with login: Recovery code not available");
                    if (typeof window.notifyPrisonScriptComplete === 'function') {
                        window.notifyPrisonScriptComplete('ERROR: Recovery code not available');
                        if (window.prisonTimeoutId) {
                            clearTimeout(window.prisonTimeoutId);
                        }
                    }
                    return;
                }
                
                // === Login Steps ===
                console.log("--- Login Steps Start ---");

                // 1. Wait for and click the black secondary button
                console.log("Login: Waiting for black secondary button...");
                const blackSecondaryButton = await waitForElementCSS(".mdc-button--black-secondary > .mdc-button__label", document, 15000);
                console.log("Login: Clicking black secondary button:", blackSecondaryButton);
                blackSecondaryButton.click();
                await delay(500); // Small delay after click

                // 2. Wait for and interact with the recoveryCode input
                console.log("Login: Waiting for recoveryCode input...");
                const recoveryCodeInput = await waitForElementCSS("input[name='recoveryCode']", document, 15000);
                console.log("Login: Clicking recoveryCode input:", recoveryCodeInput);
                recoveryCodeInput.click();
                await delay(200); // Small delay after click

                console.log(`Login: Sending recovery code to input...`);
                recoveryCodeInput.value = recoveryCode; // Set the input value from global var
                recoveryCodeInput.dispatchEvent(new Event('input', { bubbles: true })); // Trigger input event
                await delay(200); // Small delay after input

                console.log("Login: Sending Enter key to recoveryCode input...");
                // Dispatch a sequence of keyboard events for better compatibility
                const keyEvents = [
                    new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13 }),
                    new KeyboardEvent('keypress', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13 }),
                    new KeyboardEvent('keyup', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13 })
                ];
                keyEvents.forEach(event => recoveryCodeInput.dispatchEvent(event));

                // Fallback: Trigger form submission if the input is inside a form
                const parentForm = recoveryCodeInput.closest('form');
                if (parentForm) {
                    console.log("Login: Found parent form, triggering submit event...");
                    parentForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
                } else {
                    console.log("Login: No parent form found, relying on keyboard events.");
                }
                await delay(1000); // Wait for potential form submission or page update

                console.log("--- Login Steps Completed Successfully ---");
            }

            // === Sequence Part 1 (from XPath Mod script) ===
            console.log("--- Part 1 Start ---");

            // 3. Wait for and click the top bar title button (using CSS)
            console.log("Part 1: Waiting for top bar button...");
            const topBarButton = await waitForElementCSS(".mdc-button > .mdc-top-app-bar__title", document);
            console.log("Part 1: Clicking top bar button:", topBarButton);
            topBarButton.click();
            await delay(500); // Small delay after click

            // 4. Wait for and click the first list item (using CSS)
            console.log("Part 1: Waiting for list item...");
            const listItem = await waitForElementCSS(".-list > .mdc-list-item:nth-child(1) > .mdc-list-item__text", document);
            console.log("Part 1: Clicking list item:", listItem);
            listItem.click();
            await delay(2000); // Wait for potential content load

            // 5. Wait for the specific iframe (index 1) and get its document
            const frameIndex1 = 1; // Second iframe (0-based index)
            console.log(`Part 1: Waiting for iframe index ${frameIndex1} and its document...`);
            const { frameDocument: frameDoc1 } = await waitForFrameAndGetDocument(frameIndex1); // Destructure to get frameDocument
            await delay(1000); // Allow frame content to settle

            // 6. Wait for and click the element *inside* the iframe using XPath
            const targetXPath1 = "//h1[contains(.,'Diamond Prison Escape')]";
            console.log(`Part 1: Waiting for element inside frame ${frameIndex1} with XPath: ${targetXPath1}`);
            const elementInFrame1 = await waitForElementXPath(targetXPath1, frameDoc1); // Pass frameDoc1 as context
            console.log(`Part 1: Clicking element inside frame ${frameIndex1}:`, elementInFrame1);
            elementInFrame1.click(); // Clicking the found H1 element
            await delay(500); // Delay after click within frame

            console.log("--- Part 1 Completed Successfully ---");

            // === Sequence Part 2 (from Bot Automator script) ===
            console.log("--- Part 2 Start ---");

            // 7. Click "Yes" paragraph (in iframe 1)
            console.log("Part 2: Waiting for 'Yes' paragraph (iframe 1)...");
            const targetXPath2 = "//p[contains(.,'Yes')]";
            const yesElement = await waitForElementXPath(targetXPath2, frameDoc1, 15000); // Use frameDoc1 as context
            console.log(`Part 2: Clicking 'Yes' paragraph inside frame ${frameIndex1}:`, yesElement);
            yesElement.click();
            await delay(1000); // Small delay after click

            // 8. Click the image inside the second button (in the main document)
            console.log("Part 2: Waiting for the second button's image (main document)...");
            const secondButtonImg = await waitForElementXPath("//button[2]/img", document);
            console.log("Part 2: Second button image found, clicking...");
            secondButtonImg.click();
            await delay(1500); // Wait for potential frame load/update

            // 9. Wait for the third iframe (index 2) and get its document
            const frameIndex2 = 1; // Third iframe (0-based index)
            console.log(`Part 2: Waiting for iframe index ${frameIndex2} and its document...`);
            const { frameDocument: frameDoc2 } = await waitForFrameAndGetDocument(frameIndex2); // Destructure to get frameDocument
            console.log(`Part 2: Switched context to iframe ${frameIndex2}'s document.`);
            await delay(1500); // Allow frame content to settle

            // 10. Click planet name (or THE_BOT) inside the iframe
            console.log(`Part 2: Waiting for '${planetName || "THE_BOT"}' element inside iframe ${frameIndex2}...`);

            // Use the planet name if available, otherwise fall back to "THE_BOT"
            const botXPath = planetName ?
                `//b[contains(text(),'${planetName}')]` :
                "//b[contains(.,'THE_BOT')]";

            try {
                const botElement = await waitForElementXPath(botXPath, frameDoc2, 5000); // Use frameDoc2 as context, shorter timeout
                console.log(`Part 2: '${planetName || "THE_BOT"}' element found, clicking...`);
                botElement.click();
            } catch (error) {
                console.warn(`Could not find element with name '${planetName}', falling back to THE_BOT...`);
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

            // 11. Click "Visit Planet" inside the iframe (index 2)
			console.log(`Part 2: Waiting for 'Visit Planet' link inside iframe ${frameIndex3}...`);
			const visitPlanetLink = await waitForElementXPath("//a[contains(text(),'Visit Planet')]", frameDoc3); // Use frameDoc3 as context
			console.log("Part 2: 'Visit Planet' link found, clicking...");
			visitPlanetLink.click();
			const exitLink = await waitForElementXPath("//a[contains(.,'Exit')]", document, 50);
			console.log("Part 2: 'Exit' link found in main document, clicking...");
			exitLink.click();
            console.log("--- Part 2 Completed Successfully ---");
            console.log("Galaxy Combined Automation Script: Full sequence completed successfully.");

            // Notify Puppeteer that the script has completed successfully
            if (typeof window.notifyPrisonScriptComplete === 'function') {
                window.notifyPrisonScriptComplete('SUCCESS');
            }

        } catch (error) {
            console.error("Galaxy Combined Automation Script: An error occurred during the sequence:", error);

            // Notify Puppeteer of the error
            if (typeof window.notifyPrisonScriptComplete === 'function') {
                window.notifyPrisonScriptComplete('ERROR: ' + error.message);
                // Clear the timeout if it was set
                if (window.prisonTimeoutId) {
                    clearTimeout(window.prisonTimeoutId);
                }
            }
        }
    }

    // --- Start the automation ---
    // @run-at document-idle ensures the basic DOM is ready.
    // No extra delay needed unless specific dynamic loading *after* idle is known.
    performAutomationSequence();

})();