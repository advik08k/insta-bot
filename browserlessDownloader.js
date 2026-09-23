const puppeteer = require('puppeteer-core');
const fs = require('fs');
const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN || '2VJShxJ7icjitaGa2aa839c5565d28f882ae36a6463131355';

async function browserlessDownload(youtubeUrl, videoPath, addLog) {
    addLog(`[+] Connecting to Browserless.io Remote Browser...`);
    
    let browser;
    try {
        browser = await puppeteer.connect({
            browserWSEndpoint: `wss://chrome.browserless.io?token=${BROWSERLESS_TOKEN}`,
            defaultViewport: null
        });
    } catch (e) {
        throw new Error(`Browserless connection failed: ${e.message}`);
    }

    let downloadUrl = null;

    try {
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        addLog(`[+] Requesting loader.to via Remote Browser...`);
        const targetInitUrl = `https://loader.to/ajax/download.php?format=1080&url=${encodeURIComponent(youtubeUrl)}`;
        
        await page.goto(targetInitUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
        const initDataStr = await page.evaluate(() => document.body.innerText);
        const initData = JSON.parse(initDataStr);
        
        if (!initData || !initData.id) {
            throw new Error('Failed to get loader.to Task ID');
        }

        const taskId = initData.id;
        addLog(`[+] Task ID obtained (${taskId}). Polling for final video URL...`);

        // Poll for completion
        for (let i = 0; i < 20; i++) {
            await new Promise(r => setTimeout(r, 3000));
            const progressUrl = `https://loader.to/ajax/progress.php?id=${taskId}`;
            await page.goto(progressUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });
            
            const pStr = await page.evaluate(() => document.body.innerText);
            const pData = JSON.parse(pStr);
            
            if (pData.success === 1 && pData.download_url) {
                downloadUrl = pData.download_url;
                break;
            }
        }

        if (!downloadUrl) {
            throw new Error('Timeout waiting for loader.to progress.');
        }
        
        addLog(`[+] Final URL obtained! Streaming file through Remote Browser to avoid IP locks...`);
        
        // --- CHUNKED DOWNLOAD LOGIC ---
        // Open a new page on the exact same domain to bypass CORS
        const finalHost = new URL(downloadUrl).origin;
        addLog(`[+] Navigating to ${finalHost} for CORS bypass...`);
        const fetchPage = await browser.newPage();
        await fetchPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
        await fetchPage.goto(finalHost, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});

        let fileStream = fs.createWriteStream(videoPath);
        let totalDownloaded = 0;
        
        await fetchPage.exposeFunction('onChunk', (base64Data) => {
            const buffer = Buffer.from(base64Data, 'base64');
            fileStream.write(buffer);
            totalDownloaded += buffer.length;
        });

        await fetchPage.evaluate(async (url) => {
            const res = await fetch(url);
            if (!res.ok) throw new Error('Fetch failed with status ' + res.status);
            
            const reader = res.body.getReader();
            
            while(true) {
                const {done, value} = await reader.read();
                if (done) break;
                
                // Convert Uint8Array to base64
                let binary = '';
                // Chunk the conversion to avoid Maximum call stack size exceeded
                const chunkSize = 8192;
                for (let i = 0; i < value.length; i += chunkSize) {
                    binary += String.fromCharCode.apply(null, value.subarray(i, i + chunkSize));
                }
                const b64 = btoa(binary);
                await window.onChunk(b64);
            }
        }, downloadUrl);

        fileStream.end();
        
        // Wait for file stream to finish closing
        await new Promise(resolve => fileStream.on('finish', resolve));
        
        addLog(`[+] Video download complete! Size: ${(totalDownloaded / 1024 / 1024).toFixed(2)} MB`);
        
        if (totalDownloaded < 300 * 1024) {
            throw new Error("Downloaded file is too small.");
        }

    } catch (e) {
        throw new Error(`Browserless extraction failed: ${e.message}`);
    } finally {
        await browser.close().catch(() => {});
    }
    
    return true;
}

module.exports = { browserlessDownload };
