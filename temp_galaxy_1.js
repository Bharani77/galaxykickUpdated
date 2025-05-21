async function runPrisonAutomation() {
    let browser;
    console.log('Starting prison automation...');
    try {
        browser = await puppeteer.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage', // Common in Docker/CI
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu' // Often necessary in headless
            ],
            dumpio: process.env.DEBUG === 'true' // Pipe browser I/O to process for debugging
        });
        const page = await browser.newPage();

        console.log('Navigating to https://galaxy.mobstudio.ru/web/');
        await page.goto('https://galaxy.mobstudio.ru/web/', { waitUntil: 'networkidle0', timeout: 60000 });
        
        let onPrisonScriptDoneCallback;
        const prisonScriptPromise = new Promise(resolve => {
            onPrisonScriptDoneCallback = (status) => {
                console.log(`onPrisonScriptDone called with status: ${status}`);
                resolve(status); // Resolve with the status directly
            };
        });

        await page.exposeFunction('onPrisonScriptDone', onPrisonScriptDoneCallback);

        const prisonScriptContent = await fs.readFile('prison.user_1.js', 'utf8');
        console.log('Successfully read prison.user_1.js');
        
        await page.evaluate(prisonScriptContent);
        console.log('Prison script injected and evaluated.');
        
        const timeoutPromise = new Promise((resolve) => {
            const fiveMinutes = 5 * 60 * 1000;
            setTimeout(() => resolve({ status: 'TIMEOUT', message: 'Prison automation timed out after 5 minutes.' }), fiveMinutes);
        });

        console.log('Waiting for prison script to complete or timeout...');
        const result = await Promise.race([prisonScriptPromise, timeoutPromise]);
        
        if (typeof result === 'string') {
            console.log(`Prison automation finished with result: ${result}`);
            return result; 
        } else if (result && typeof result.status !== 'undefined') {
            console.log(`Prison automation finished with status: ${result.status}, message: ${result.message || 'N/A'}`);
            return result; 
        } else {
            console.warn(`Prison automation finished with unexpected result type: ${JSON.stringify(result)}`);
            return { status: 'UNKNOWN_RESULT', message: 'The script finished with an unknown result type.'};
        }

    } catch (error) {
        console.error('Error during prison automation:', error);
        return { status: 'ERROR', message: error.message };
    } finally {
        if (browser) {
            try {
                console.log('Closing browser...');
                await browser.close();
            } catch (closeError) {
                console.error('Error closing browser:', closeError);
            }
        }
        console.log('Prison automation attempt finished.');
    }
}
