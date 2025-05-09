// ==UserScript==
// @name         Galaxy Auto-Attacker Ultimate (Puppeteer Controlled v6.0)
// @namespace    http://tampermonkey.net/
// @version      6.0 // Version increment for Puppeteer control
// @description  Ultimate attack automation - Triggered by Puppeteer
// @author       Anonymous (Modified for Puppeteer)
// @match        https://galaxy.mobstudio.ru/web/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @run-at       document-start // Keep running early for initialization
// ==/UserScript==

(function() {
    'use strict';
    // Use GM_log or console.log for output (GM_log might be shimmed by Puppeteer)
    const log = typeof GM_log !== 'undefined' ? GM_log : console.log;
    const errorLog = typeof GM_log !== 'undefined' ? GM_log : console.error; // Use same for error for simplicity
  
    log('[UserScript] Initializing v6.0 (Puppeteer Controlled)...');
  
    // --- Configuration --- (Keep defaults, actual values loaded from GM)
    const CONFIG = {
        actionDelay: 50, // Slightly increased default action delay
        reloadDelay: 500, // No longer used for auto-reload
        maxRetries: 5, // Still defined but not explicitly used in core loop
        selectors: {
            // Verify these selectors are still correct in the target site
            menu: ".mdc-menu:nth-child(1)",             // Player list container?
            listItem: ".mdc-list-item",                 // Item within a list
            text: ".mdc-list-item__text",               // Text part of a list item
            closeButton: ".dialog__close-button > img", // A generic close button
            titleButton: ".mdc-button > .mdc-top-app-bar__title", // Button to open main menu?
            actionImage: ".planet-bar__button__action > img", // Button on player profile?
            playerListMenuOption: ".-list > .mdc-list-item:nth-child(3) > .mdc-list-item__text", // "Players" option in main menu?
            attackActionMenuItem: ".mdc-menu .mdc-list-item:last-child > .mdc-list-item__text",
            resetUiElement: ".start__user:nth-child(1) > .start__user__avatar" // User's own avatar to reset UI?
        },
        // These timing params will be overwritten by values from GM_getValue
        timingParams: {
            startAttack: 50,
            startIntervalAttack: 10,
            stopAttack: 500,
            startDefence: 50,
            startDefenceInterval: 10,
            stopDefence: 500
        },
        // Runtime state for delays, managed internally
        currentAttackDelay: 0,
        currentDefenceDelay: 0
    };
  
    // --- State ---
    let rivalName = ''; // Store rival name locally, loaded from GM
    let isInitialized = false; // Track if internal setup is done
    window.isAttacking = false; // Global flag (on unsafeWindow) to prevent concurrent runs
  
    // --- Initialization Function ---
    // Run once when script loads to set initial state
    function initializeInternalConfig() {
        log('[UserScript] Running initializeInternalConfig...');
        // Initialize delays with defaults from CONFIG initially
        CONFIG.currentAttackDelay = CONFIG.timingParams.startAttack;
        CONFIG.currentDefenceDelay = CONFIG.timingParams.startDefence;
        isInitialized = true;
        log('[UserScript] Internal config initialized.');
    }
  
    // --- Load External Values (Called before execution) ---
    // Reads parameters set by Puppeteer via GM_setValue
    async function loadExternalValues(specificRivalName = null) {
      log('[UserScript] Loading external values from GM storage...');
      let rivalNameLoaded = false;
      let paramsLoaded = false;
      try {
          const storedParams = await GM_getValue('TIMING_PARAMS', null);
          if (storedParams) {
              try {
                  const parsedParams = JSON.parse(storedParams);
                  // Merge loaded params into CONFIG, overwriting defaults
                  CONFIG.timingParams = { ...CONFIG.timingParams, ...parsedParams };
                  log('[UserScript CONFIG] Loaded timing parameters:', CONFIG.timingParams);
                  
                  paramsLoaded = true;
              } catch (e) {
                  errorLog('[UserScript CONFIG] Error parsing timing parameters:', e);
                  // Keep using defaults if parsing fails
              }
          } else {
              log('[UserScript CONFIG] No timing parameters found in storage. Using defaults.');
          }
          
          // Load current attack delay, or use the start value if not found
          const storedCurrentAttackDelay = await GM_getValue('CURRENT_ATTACK_DELAY', null);
          if (storedCurrentAttackDelay !== null) {
              CONFIG.currentAttackDelay = parseInt(storedCurrentAttackDelay);
              log(`[UserScript CONFIG] Loaded current attack delay: ${CONFIG.currentAttackDelay}ms`);
          } else {
              CONFIG.currentAttackDelay = CONFIG.timingParams.startAttack;
              log(`[UserScript CONFIG] Initialized current attack delay to start value: ${CONFIG.currentAttackDelay}ms`);
          }
  
          // Load current defence delay, or use the start value if not found
          const storedCurrentDefenceDelay = await GM_getValue('CURRENT_DEFENCE_DELAY', null);
          if (storedCurrentDefenceDelay !== null) {
              CONFIG.currentDefenceDelay = parseInt(storedCurrentDefenceDelay);
              log(`[UserScript CONFIG] Loaded current defence delay: ${CONFIG.currentDefenceDelay}ms`);
          } else {
              CONFIG.currentDefenceDelay = CONFIG.timingParams.startDefence;
              log(`[UserScript CONFIG] Initialized current defence delay to start value: ${CONFIG.currentDefenceDelay}ms`);
          }
  
          // Use the specific rival name if provided, otherwise fall back to stored names
          if (specificRivalName) {
              rivalName = specificRivalName.trim();
              log(`[UserScript CONFIG] Using specific rival name passed from Puppeteer: "${rivalName}"`);
              rivalNameLoaded = true;
          } else {
              // Fall back to stored rival names if specific name not provided
              const storedRivalNames = await GM_getValue('RIVAL_NAMES', []);
              
              // If it's an array, use the first name, otherwise try to use it as-is
              if (Array.isArray(storedRivalNames) && storedRivalNames.length > 0) {
                  rivalName = storedRivalNames[0].trim(); // Use the first name
                  log(`[UserScript CONFIG] Using first rival name from array: "${rivalName}"`);
              } else if (typeof storedRivalNames === 'string') {
                  rivalName = storedRivalNames.trim();
                  log(`[UserScript CONFIG] Using rival name as string: "${rivalName}"`);
              } else {
                  errorLog('[UserScript CONFIG] Invalid rival names format in storage.');
                  rivalNameLoaded = false;
                  return false;
              }
  
              if (!rivalName) {
                  errorLog('[UserScript CONFIG] CRITICAL: Rival name not found or empty in storage.');
                  rivalNameLoaded = false;
              } else {
                  log(`[UserScript CONFIG] Rival name loaded: "${rivalName}"`);
                  rivalNameLoaded = true;
              }
          }
          
          return rivalNameLoaded && paramsLoaded; // Return true only if both are successfully loaded/parsed
  
      } catch (err) {
          errorLog('[UserScript] Error during loadExternalValues:', err);
          return false; // Indicate failure
      }
    }
    
    // --- Helper Functions ---
  
    function delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function waitForElementXPath(xpathExpression, timeout = 1000) {
        return new Promise((resolve) => {
            const intervalTime = 150;
            let elapsedTime = 0;
    
            const checkElement = () => {
                const result = document.evaluate(
                    xpathExpression,
                    document,
                    null,
                    XPathResult.FIRST_ORDERED_NODE_TYPE,
                    null
                );
                const el = result.singleNodeValue;
                
                // Basic visibility check
                const isVisible = el && el.offsetParent !== null && 
                    window.getComputedStyle(el).visibility !== 'hidden' && 
                    window.getComputedStyle(el).display !== 'none';
    
                if (isVisible) {
                    clearInterval(interval);
                    clearTimeout(timer);
                    resolve(el);
                } else {
                    elapsedTime += intervalTime;
                    if (elapsedTime >= timeout) {
                        clearInterval(interval);
                        resolve(null); // Resolve with null on timeout
                    }
                }
            };
    
            // Check immediately
            const initialResult = document.evaluate(
                xpathExpression,
                document,
                null,
                XPathResult.FIRST_ORDERED_NODE_TYPE,
                null
            );
            const initialEl = initialResult.singleNodeValue;
            const initialVisible = initialEl && initialEl.offsetParent !== null && 
                window.getComputedStyle(initialEl).visibility !== 'hidden' && 
                window.getComputedStyle(initialEl).display !== 'none';
            
            if(initialVisible) {
                return resolve(initialEl);
            }
    
            const interval = setInterval(checkElement, intervalTime);
            const timer = setTimeout(() => {
                clearInterval(interval);
                resolve(null); // Ensure resolution on timeout
            }, timeout);
        });
    }
    
    // New function to click an element using XPath
    async function clickElementXPath(xpathExpression, clickTimeout = 1000, stepName = "Unknown Step") {
        const element = await waitForElementXPath(xpathExpression, clickTimeout);
        if (!element) {
            errorLog(`[UserScript ATTACK ${stepName}] XPath element not found/visible for click: ${xpathExpression}`);
            return false; // Indicate failure
        }
        try {
            element.click();
            log(`[UserScript ATTACK ${stepName}] Clicked XPath: ${xpathExpression}`);
            await delay(CONFIG.actionDelay); // Use configured delay after click
            return true; // Indicate success
        } catch (error) {
            errorLog(`[UserScript ATTACK ${stepName}] Failed to click XPath ${xpathExpression}: ${error.message}`);
            return false; // Indicate failure
        }
    }
      
        // Wait for an element to exist and be visible (optional)
        function waitForElement(selector, timeout = 1000) {
            // log(`[UserScript waitForElement] Waiting for: ${selector}`); // Verbose log
            return new Promise((resolve) => {
                const intervalTime = 150;
                let elapsedTime = 0;
      
                const checkElement = () => {
                    const el = document.querySelector(selector);
                    // Basic visibility check (might need refinement depending on CSS)
                    const isVisible = el && el.offsetParent !== null && window.getComputedStyle(el).visibility !== 'hidden' && window.getComputedStyle(el).display !== 'none';
      
                    if (isVisible) {
                        // log(`[UserScript waitForElement] Found: ${selector}`);
                        clearInterval(interval);
                        clearTimeout(timer);
                        resolve(el);
                    } else {
                        elapsedTime += intervalTime;
                        if (elapsedTime >= timeout) {
                            // log(`[UserScript waitForElement] Timeout waiting for: ${selector}`);
                            clearInterval(interval);
                            resolve(null); // Resolve with null on timeout
                        }
                    }
                };
      
                // Check immediately
                 const initialEl = document.querySelector(selector);
                 const initialVisible = initialEl && initialEl.offsetParent !== null && window.getComputedStyle(initialEl).visibility !== 'hidden' && window.getComputedStyle(initialEl).display !== 'none';
                 if(initialVisible) {
                     // log(`[UserScript waitForElement] Found immediately: ${selector}`);
                     return resolve(initialEl);
                 }
      
                const interval = setInterval(checkElement, intervalTime);
                const timer = setTimeout(() => {
                     // log(`[UserScript waitForElement] Timeout fallback for: ${selector}`);
                     clearInterval(interval);
                     resolve(null); // Ensure resolution on timeout
                }, timeout);
            });
        }
      
    
  
    // Wait for an element to exist and be visible (optional)
    function waitForElement(selector, timeout = 1000) {
        // log(`[UserScript waitForElement] Waiting for: ${selector}`); // Verbose log
        return new Promise((resolve) => {
            const intervalTime = 150;
            let elapsedTime = 0;
  
            const checkElement = () => {
                const el = document.querySelector(selector);
                // Basic visibility check (might need refinement depending on CSS)
                const isVisible = el && el.offsetParent !== null && window.getComputedStyle(el).visibility !== 'hidden' && window.getComputedStyle(el).display !== 'none';
  
                if (isVisible) {
                    // log(`[UserScript waitForElement] Found: ${selector}`);
                    clearInterval(interval);
                    clearTimeout(timer);
                    resolve(el);
                } else {
                    elapsedTime += intervalTime;
                    if (elapsedTime >= timeout) {
                        // log(`[UserScript waitForElement] Timeout waiting for: ${selector}`);
                        clearInterval(interval);
                        resolve(null); // Resolve with null on timeout
                    }
                }
            };
  
            // Check immediately
             const initialEl = document.querySelector(selector);
             const initialVisible = initialEl && initialEl.offsetParent !== null && window.getComputedStyle(initialEl).visibility !== 'hidden' && window.getComputedStyle(initialEl).display !== 'none';
             if(initialVisible) {
                 // log(`[UserScript waitForElement] Found immediately: ${selector}`);
                 return resolve(initialEl);
             }
  
            const interval = setInterval(checkElement, intervalTime);
            const timer = setTimeout(() => {
                 // log(`[UserScript waitForElement] Timeout fallback for: ${selector}`);
                 clearInterval(interval);
                 resolve(null); // Ensure resolution on timeout
            }, timeout);
        });
    }
  
    // Click element function using waitForElement
    async function clickElement(selector, clickTimeout = 1000, stepName = "Unknown Step") {
        const element = await waitForElement(selector, clickTimeout);
        if (!element) {
            errorLog(`[UserScript ATTACK ${stepName}] Element not found/visible for click: ${selector}`);
            return false; // Indicate failure
        }
        try {
            element.click();
            log(`[UserScript ATTACK ${stepName}] Clicked: ${selector}`);
            await delay(CONFIG.actionDelay); // Use configured delay after click
            return true; // Indicate success
        } catch (error) {
            errorLog(`[UserScript ATTACK ${stepName}] Failed to click ${selector}: ${error.message}`);
            return false; // Indicate failure
        }
    }
  
     // Enhanced Rival Selection in List
     async function selectRivalInList(nameToFind) {
         const stepName = "SelectRival";
         try {
             log(`[UserScript ATTACK ${stepName}] Looking for rival: "${nameToFind}" in menu: ${CONFIG.selectors.menu}`);
             const menu = await waitForElement(CONFIG.selectors.menu, 1000);
             if (!menu) {
                 errorLog(`[UserScript ATTACK ${stepName}] Player list menu container not found.`);
                 return false;
             }
  
             const items = menu.querySelectorAll(CONFIG.selectors.listItem);
             log(`[UserScript ATTACK ${stepName}] Found ${items.length} list items.`);
  
             if (items.length === 0) {
                 log(`[UserScript ATTACK ${stepName}] No list items found.`);
                 return false;
             }
  
             let found = false;
             for (const item of items) {
                 const textElement = item.querySelector(CONFIG.selectors.text);
                 const text = textElement?.textContent?.trim();
  
                 // Log comparison for debugging
                 // log(`[UserScript SELECT] Comparing: Item text "${text}" === Target name "${nameToFind}"`);
  
                 if (text && text === nameToFind) {
                     log(`[UserScript ATTACK ${stepName}] Found matching rival: "${nameToFind}", clicking item.`);
                     item.click(); // Direct click on the found item
                     await delay(CONFIG.actionDelay);
                     found = true;
                     break;
                 }
             }
  
             if (!found) {
                 log(`[UserScript ATTACK ${stepName}] Rival "${nameToFind}" not found in the list.`);
             }
             return found;
  
         } catch (e) {
             errorLog(`[UserScript ATTACK ${stepName} ERROR] Error during rival selection:`, e);
             return false;
         }
     }
  
  
    // --- Main Execution Function (Called by Puppeteer) ---
    // This function now contains the logic previously in executeAttackSequence
    window.executeTampermonkeyLogic = async (messageType, specificRivalName) => {
        log(`[UserScript] executeTampermonkeyLogic called by Puppeteer. Trigger Type: ${messageType}, SpecificRival: ${specificRivalName || 'Not specified'}`);
  
        if (window.isAttacking) {
            log('[UserScript ATTACK] Execution request ignored: Attack already in progress.');
            // Notify Puppeteer? Decide if this state should trigger completion signal or not.
            // For now, we don't signal completion here, letting the existing run finish.
            return;
        }
  
        // Set flag immediately
        window.isAttacking = true;
        log('[UserScript ATTACK] LOCK acquired.');
  
        let executionStatus = 'FAILED'; // Default status
  
        try {
            // Load latest timing params and use specified rival name if provided
            const loadedOK = await loadExternalValues(specificRivalName);
            if (!loadedOK || !rivalName) {
                 throw new Error("Failed to load necessary configuration (rival name or timing params) from GM storage.");
            }
             log(`[UserScript ATTACK] Starting sequence for: "${rivalName}" (Trigger: ${messageType})`);
  
            // --- Step 1: Open player list ---
            if (!await clickElement(CONFIG.selectors.titleButton, 200, "Step 1a: Open Main Menu")) throw new Error("Step 1a Failed");
            if (!await clickElement(CONFIG.selectors.playerListMenuOption, 200, "Step 1b: Click Players Option")) throw new Error("Step 1b Failed");
            log('[UserScript ATTACK] Step 1: Player list opened (presumably).');
  
            // --- Step 2: Select rival from list ---
            if (!await selectRivalInList(rivalName)) throw new Error(`Step 2 Failed: Rival "${rivalName}" not found/selected in list.`);
            log('[UserScript ATTACK] Step 2: Rival selected.');
  
            // --- Step 3: Open action menu for the selected rival ---
            if (!await clickElement(CONFIG.selectors.actionImage, 200, "Step 3: Click Action Image")) throw new Error("Step 3 Failed");
            log('[UserScript ATTACK] Step 3: Action menu opened (presumably).');
  
            // --- Step 4: Apply specific delay based on trigger type ---
            log('[UserScript ATTACK] Step 4: Applying delay...');
            let currentDelay = 0;
            if (messageType === 'JOIN') {
                currentDelay = CONFIG.currentAttackDelay;
                log(`[UserScript TIMING] Applying JOIN attack delay: ${currentDelay}ms`);
                await delay(currentDelay);
                // Cycle delay for next time
                CONFIG.currentAttackDelay += CONFIG.timingParams.startIntervalAttack;
                if (CONFIG.currentAttackDelay > CONFIG.timingParams.stopAttack) {
                  CONFIG.currentAttackDelay = CONFIG.timingParams.startAttack;
                }
                GM_setValue('CURRENT_ATTACK_DELAY', CONFIG.currentAttackDelay);
                log(`[UserScript TIMING] Next JOIN attack delay will be: ${CONFIG.currentAttackDelay}ms`);
  
            } else if (messageType === '353') {
                currentDelay = CONFIG.currentDefenceDelay;
                log(`[UserScript TIMING] Applying 353 defence delay: ${currentDelay}ms`);
                await delay(currentDelay);
                // Cycle delay for next time
                CONFIG.currentDefenceDelay += CONFIG.timingParams.startDefenceInterval;
                if (CONFIG.currentDefenceDelay > CONFIG.timingParams.stopDefence) {
                  CONFIG.currentDefenceDelay = CONFIG.timingParams.startDefence;
                }
                GM_setValue('CURRENT_DEFENCE_DELAY', CONFIG.currentDefenceDelay);
                log(`[UserScript TIMING] Next 353 defence delay will be: ${CONFIG.currentDefenceDelay}ms`);
            } else {
                 log(`[UserScript TIMING] Unknown message type "${messageType}", applying default 0ms delay.`);
                 await delay(0);
            }
             log('[UserScript ATTACK] Step 4: Delay applied.');
  
            // --- Step 5: Click the specific action (e.g., "Attack") ---
             // Ensure the selector targets the item within the correct menu context if menus overlay
            if (!await clickElement(CONFIG.selectors.attackActionMenuItem, 200, "Step 5: Select Attack Action")) throw new Error("Step 5 Failed");
            log('[UserScript ATTACK] Step 5: Action selected (presumably Attack).');
  
            // --- Step 6: Click final confirmation / choose attack type ---
            if (!await clickElementXPath("//a[contains(.,'Exit')]", 200, "Step 6: Final Confirmation")) throw new Error("Step 6 Failed");
            log('[UserScript ATTACK] Step 6: Final confirmation clicked.');
  
            log(`[UserScript ATTACK] Sequence for "${rivalName}" potentially completed successfully.`);
            executionStatus = 'SUCCESS'; // Mark as successful if we reached here
  
            // --- Step 7: Reset UI state (Attempt) ---
            log('[UserScript ATTACK] Step 7: Attempting to reset UI state...');
          
            if (!await clickElement(CONFIG.selectors.resetUiElement, 200, "Step 7: Reset UI")) {
                 log('[UserScript ATTACK] Step 7: Failed to click reset UI element (e.g., avatar). May not be critical.');
                 // Try generic close button as fallback?
                 // await clickElement(CONFIG.selectors.closeButton, 1000, "Step 7b: Fallback Close");
            } else {
                 log('[UserScript ATTACK] Step 7: UI reset attempt complete.');
            }
  
        } catch (e) {
            errorLog('[UserScript ATTACK FAILED] Error during execution:', e.message);
            executionStatus = `FAILED: ${e.message}`; // Report specific error message
            // Attempt a generic close on any unexpected error during the main sequence
            try {
                log('[UserScript ATTACK FAILED] Attempting emergency close...');
                await clickElement(CONFIG.selectors.closeButton, 200, "Emergency Close");
            } catch (closeError) {
                errorLog('[UserScript ATTACK FAILED] Emergency close also failed:', closeError);
            }
  
        } finally {
            // *** CRITICAL: Ensure the flag is always cleared ***
            window.isAttacking = false;
            log('[UserScript ATTACK] LOCK released.');
  
            // --- Signal completion back to Puppeteer ---
            if (typeof window.notifyPuppeteerComplete === 'function') {
                log(`[UserScript] Notifying Puppeteer of completion. Status: ${executionStatus}`);
                // Add a small delay before notifying if needed, e.g., ensure UI updates finish
                window.notifyPuppeteerComplete(executionStatus); // Call the function exposed by Puppeteer
            } else {
                errorLog('[UserScript] Cannot notify Puppeteer: notifyPuppeteerComplete function not found.');
            }
            // !!! REMOVED automatic location.reload() - Puppeteer handles this !!!
        }
    }; // End of executeTampermonkeyLogic
  
    // --- Start Script Logic ---
  
    try {
        // Existing initialization code...
        initializeInternalConfig();
        window.tampermonkeyReady = true;
        console.log('[UserScript] Script marked as ready');
    } catch(e) {
        console.error('[UserScript] Initialization error:', e);
        window.tampermonkeyReady = 'error';
    }
  
    // 2. Script is now passive. It waits for Puppeteer to call `window.executeTampermonkeyLogic`.
    log('[UserScript] Script loaded and initialized. Waiting for Puppeteer trigger via executeTampermonkeyLogic().');
  
    // No WebSocket interception or auto-start logic needed here anymore.
  // Signal that the script is fully loaded and ready
  
    log('[UserScript] Tampermonkey script fully loaded and ready.');
  })(); // End of UserScript IIFE
  // --- END OF FILE ---