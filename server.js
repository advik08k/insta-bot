const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const youtubedl = require('youtube-dl-exec');
const cron = require('node-cron');
const axios = require('axios');
const { exec } = require('child_process');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const { initDB, loadDB, saveDB } = require('./github-db');

let memoryLogs = ['System initialized. Waiting for events...'];
const addLog = (msg) => {
    console.log(msg);
    const timeStr = new Date().toLocaleTimeString('en-US', { timeZone: 'Asia/Kolkata' });
    memoryLogs.push(`[${timeStr}] ${msg}`);
    if (memoryLogs.length > 100) memoryLogs.shift();
};

// --- API Endpoints ---
app.get('/api/accounts', (req, res) => {
    const db = loadDB();
    res.json(db.accounts.map(acc => ({
        id: acc.id,
        username: acc.username,
        targetChannel: acc.targetChannel,
        queueLength: acc.queue ? acc.queue.length : 0,
        uploadedCount: acc.uploadedVideos ? acc.uploadedVideos.length : 0,
        nextUploadTime: acc.nextUploadTime,
        uploadInterval: acc.uploadInterval,
        skipCount: acc.skipCount,
        isPaused: acc.isPaused || false
    })));
});

app.post('/api/accounts', (req, res) => {
    const { sessionId, targetChannel, uploadInterval, skipCount } = req.body;
    if (!sessionId || !targetChannel) return res.status(400).json({ error: "Missing required fields" });

    addLog(`[+] Verifying Session ID...`);
    exec(`python get_username.py "${sessionId}"`, (error, stdout, stderr) => {
        let username = "Unknown Account";
        try {
            const data = JSON.parse(stdout);
            if (data.success) username = data.username;
        } catch (e) {}

        const db = loadDB();
        const newAcc = {
            id: 'acc_' + Date.now(),
            username,
            sessionId,
            targetChannel,
            skipCount: skipCount || '0',
            uploadInterval: uploadInterval || 'default',
            queue: [],
            uploadedVideos: [],
            nextUploadTime: 0,
            nextDelay30: true
        };
        db.accounts.push(newAcc);
        saveDB(db, addLog);
        addLog(`[+] Account '${username}' added successfully.`);
        res.json({ success: true, account: newAcc });
    });
});

app.delete('/api/accounts/:id', (req, res) => {
    const db = loadDB();
    db.accounts = db.accounts.filter(a => a.id !== req.params.id);
    saveDB(db, addLog);
    addLog(`[+] Removed account ${req.params.id}`);
    res.json({ success: true });
});

app.post('/api/accounts/:id/settings', (req, res) => {
    const db = loadDB();
    const acc = db.accounts.find(a => a.id === req.params.id);
    if (!acc) return res.status(404).json({ error: "Account not found" });
    
    if (req.body.isPaused !== undefined) {
        acc.isPaused = req.body.isPaused;
        addLog(`[+] Account ${acc.username} auto-post set to: ${acc.isPaused ? 'PAUSED' : 'ACTIVE'}`);
    }
    
    if (req.body.uploadInterval !== undefined) {
        acc.uploadInterval = req.body.uploadInterval;
        const newMins = parseInt(req.body.uploadInterval) || 60;
        acc.nextUploadTime = Date.now() + (newMins * 60 * 1000);
        addLog(`[+] Account ${acc.username} upload interval set to: ${acc.uploadInterval} mins. Timer reset.`);
    }
    
    saveDB(db, addLog);
    res.json({ success: true });
});

app.post('/api/cookies', (req, res) => {
    const db = loadDB();
    db.ytCookies = req.body.ytCookies;
    saveDB(db, addLog);
    res.json({ success: true });
});

app.get('/api/cookies', (req, res) => {
    res.json({ ytCookies: loadDB().ytCookies });
});

app.get('/api/logs', (req, res) => res.json({ logs: memoryLogs }));

app.post('/api/trigger/:id', (req, res) => {
    const db = loadDB();
    const acc = db.accounts.find(a => a.id === req.params.id);
    if (!acc) return res.status(404).json({ error: "Account not found" });
    
    res.json({ success: true, message: "Upload cycle forced for " + acc.username });
    acc.nextUploadTime = 0; // force immediate
    saveDB(db, addLog);
    executeAutoUpload(); 
});

let isProcessing = false;

const refreshQueueForAccount = async (account, db) => {
    addLog(`[+] Scraping Shorts for ${account.username} from ${account.targetChannel}...`);
    
    let channelUrl = account.targetChannel;
    try {
        const urlObj = new URL(channelUrl);
        urlObj.search = '';
        if (!urlObj.pathname.endsWith('/shorts')) urlObj.pathname = urlObj.pathname.replace(/\/$/, '') + '/shorts';
        channelUrl = urlObj.toString();
    } catch (e) {
        if (!channelUrl.endsWith('/shorts')) channelUrl = channelUrl.replace(/\/$/, '') + '/shorts';
    }

    try {
        const options = {
            print: '%(id)s|||%(title)s',
            flatPlaylist: true,
            noWarnings: true
        };
        
        const cookiePath = path.join(__dirname, 'cookies.txt');
        if (db.ytCookies) {
            fs.writeFileSync(cookiePath, db.ytCookies);
            options.cookies = cookiePath;
        }

        addLog(`[+] [${account.username}] Checking for new videos...`);
        const ytInfo = await youtubedl(channelUrl, options);
        if (fs.existsSync(cookiePath)) fs.unlinkSync(cookiePath);

        const rawOutput = ytInfo.trim();
        if (!rawOutput) return;

        let lines = rawOutput.split('\n').reverse(); 
        
        const skipCount = parseInt(account.skipCount || '0', 10);
        if (skipCount > 0 && account.uploadedVideos.length === 0 && account.queue.length === 0) {
            addLog(`[!] [${account.username}] Skipping first ${skipCount} videos.`);
            const skippedLines = lines.slice(0, skipCount);
            account.uploadedVideos = skippedLines.map(line => line.split('|||')[0]);
            lines = lines.slice(skipCount);
        }

        let newVideos = [];
        lines.forEach(line => {
            const [id, title] = line.split('|||');
            if (id && !account.uploadedVideos.includes(id) && !account.queue.find(q => q.id === id)) {
                newVideos.push({ id, title: title || '' });
            }
        });

        if (newVideos.length > 0) {
            account.queue = [...account.queue, ...newVideos];
            saveDB(db, addLog);
            addLog(`[+] [${account.username}] Added ${newVideos.length} new Shorts. Queue size: ${account.queue.length}`);
        } else {
            addLog(`[i] [${account.username}] Scraping finished. No new videos found.`);
        }
    } catch (e) {
        addLog(`[-] [${account.username}] Scrape error: ${e.message}`);
    }
};

const executeAutoUpload = async () => {
    if (isProcessing) return;
    isProcessing = true;

    try {
        let db = loadDB();
        
        // Find the FIRST account that is due for an upload
        let accountToProcess = null;
        for (let acc of db.accounts) {
            if (acc.isPaused) continue; // Skip paused accounts
            if (!acc.nextUploadTime || Date.now() >= acc.nextUploadTime) {
                accountToProcess = acc;
                break;
            }
        }

        if (!accountToProcess) {
            isProcessing = false;
            return; // No accounts are due
        }

        if (!accountToProcess.queue || accountToProcess.queue.length < 5) {
            await refreshQueueForAccount(accountToProcess, db);
            db = loadDB(); // Reload after scrape
            accountToProcess = db.accounts.find(a => a.id === accountToProcess.id);
        }
        
        if (!accountToProcess || !accountToProcess.queue || accountToProcess.queue.length === 0) {
            addLog(`[-] [${accountToProcess ? accountToProcess.username : 'Unknown'}] Queue empty. Waiting for new videos...`);
            isProcessing = false;
            return;
        }

        const video = accountToProcess.queue.pop();
        saveDB(db, addLog);

        const youtubeUrl = `https://youtube.com/shorts/${video.id}`;
        addLog(`[+] [${accountToProcess.username}] Processing Video: "${video.title}"`);
        
        let videoPath = path.join(__dirname, `temp_${Date.now()}.mp4`);
        let optimizedPath = path.join(__dirname, `opt_${Date.now()}.mp4`);
        let thumbPath = path.join(__dirname, `thumb_${Date.now()}.jpg`);

        try {
            addLog(`[+] Requesting video from Loader.to API (1080p)...`);
            const initRes = await fetch(`https://loader.to/ajax/download.php?format=1080&url=${encodeURIComponent(youtubeUrl)}`);
            const initData = await initRes.json();
            if (!initData.id) throw new Error("Loader.to API failed to initiate task.");
            
            const taskId = initData.id;
            let downloadUrl = null;
            for (let i = 0; i < 60; i++) {
                await new Promise(resolve => setTimeout(resolve, 2000));
                const progressRes = await fetch(`https://loader.to/ajax/progress.php?id=${taskId}`);
                const progressData = await progressRes.json();
                if (progressData.success === 1 && progressData.download_url) {
                    downloadUrl = progressData.download_url;
                    break;
                }
            }
            if (!downloadUrl) throw new Error("Loader.to API timed out.");
            
            addLog(`[+] Streaming video directly to disk...`);
            const response = await fetch(downloadUrl);
            if (!response.ok) throw new Error('Download failed from Loader.to');
            
            const { Readable } = require('stream');
            const { pipeline } = require('stream/promises');
            await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(videoPath));

            addLog(`[+] Optimizing video format for Instagram (H.264)...`);
            await new Promise((resolve) => {
                exec(`ffmpeg -y -i "${videoPath}" -vf "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2" -c:v libx264 -preset ultrafast -tune zerolatency -threads 1 -max_muxing_queue_size 1024 -b:v 3M -maxrate 3.5M -bufsize 7M -profile:v high -level 4.1 -pix_fmt yuv420p -r 30 -c:a aac -b:a 128k -movflags +faststart "${optimizedPath}"`, (err) => {
                    if (err) {
                        addLog(`[-] FFmpeg Error: ${err.message}`);
                    } else {
                        if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
                        videoPath = optimizedPath;
                    }
                    resolve();
                });
            });

            addLog(`[+] Fetching thumbnail...`);
            const thumbResponse = await axios.get(`https://img.youtube.com/vi/${video.id}/maxresdefault.jpg`, { responseType: 'arraybuffer' })
                .catch(async () => await axios.get(`https://img.youtube.com/vi/${video.id}/hqdefault.jpg`, { responseType: 'arraybuffer' }));
            fs.writeFileSync(thumbPath, Buffer.from(thumbResponse.data));

            addLog(`[+] Initiating Upload for ${accountToProcess.username}...`);
            const caption = video.title ? `${video.title}\n\n#shorts #viral #reels` : 'Auto uploaded via Insta Auto Uploader 😈';
            const safeCaption = caption.replace(/"/g, '\\"');
            
            await new Promise((resolve) => {
                exec(`python upload.py "${accountToProcess.sessionId}" "${videoPath}" "${thumbPath}" "${safeCaption}"`, (error, stdout, stderr) => {
                    if (error) {
                        addLog(`[-] UPLOAD FAILED: ${error.message}`);
                        accountToProcess.queue.push(video);
                        saveDB(db, addLog);
                        resolve();
                        return;
                    }
                    
                    if (stdout.includes('"success": true') || stdout.includes('"success":true')) {
                        addLog(`[🎉] SUCCESS! Reel Published to ${accountToProcess.username}!`);
                        if (!accountToProcess.uploadedVideos.includes(video.id)) {
                            accountToProcess.uploadedVideos.push(video.id);
                        }
                        
                        let delayMins = 30;
                        // 6. Schedule Next Upload
                        const intervalMinutes = parseInt(accountToProcess.uploadInterval) || 60;
                        accountToProcess.nextUploadTime = Date.now() + (intervalMinutes * 60 * 1000);
                        saveDB(db, addLog);
                        addLog(`[+] Next upload for ${accountToProcess.username} scheduled in ${intervalMinutes} minutes.`);
                    } else {
                        addLog(`[-] Upload Failed: ${stdout}`);
                        accountToProcess.queue.push(video);
                        if (stdout.includes('feedback_required') || stdout.includes('Please wait a few minutes') || stdout.toLowerCase().includes('limit')) {
                            addLog(`[!] Action Block / Limit Reached for ${accountToProcess.username}. Auto-pausing account.`);
                            accountToProcess.isPaused = true;
                        }
                        saveDB(db, addLog);
                    }
                    resolve();
                });
            });

        } finally {
            if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
            if (fs.existsSync(optimizedPath)) fs.unlinkSync(optimizedPath);
            if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);
        }

    } catch (error) {
        addLog(`[-] ERROR: ${error.message}`);
    }
    
    isProcessing = false;
};

const PORT = process.env.PORT || 3000;

(async () => {
    await initDB(addLog);

    // --- Cron Job ---
    // Check every 1 minute if ANY account is due
    cron.schedule('* * * * *', () => {
        executeAutoUpload();
    });

    app.listen(PORT, '0.0.0.0', () => {
        addLog(`🚀 Multi-Account Engine running on port ${PORT}`);
    });
})();
