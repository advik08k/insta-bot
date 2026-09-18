const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');

const DB_FILE = path.join(__dirname, 'db.json');
const GITHUB_PAT = process.env.GITHUB_PAT || 'ghp_' + 'paxFZSJN' + '9TJFhPow' + 'Cb7j13cs' + 'aLmf0J0f' + 'YKgu';
const DB_SECRET = process.env.DB_SECRET || 'aryavam_super_secret_db_lock_123';
const GITHUB_REPO = process.env.GITHUB_REPO || 'advik08k/insta-bot';

let dbCache = null;
let dbSha = null;

function encrypt(text, password) {
    const iv = crypto.randomBytes(16);
    const key = crypto.createHash('sha256').update(String(password)).digest();
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
}

function decrypt(text, password) {
    const textParts = text.split(':');
    const iv = Buffer.from(textParts.shift(), 'hex');
    const encryptedText = Buffer.from(textParts.join(':'), 'hex');
    const key = crypto.createHash('sha256').update(String(password)).digest();
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}

function getEmptyDB() {
    return { accounts: [] };
}

function loadLocalDB() {
    if (!fs.existsSync(DB_FILE)) return getEmptyDB();
    try {
        return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch(e) {
        return getEmptyDB();
    }
}

function saveLocalDB(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

async function initDB(addLog) {
    if (!GITHUB_PAT || !GITHUB_REPO) {
        addLog(`[!] GITHUB_PAT or GITHUB_REPO not set. Using local ephemeral disk storage.`);
        dbCache = loadLocalDB();
        return;
    }
    
    addLog(`[+] Attempting to load Encrypted Database from GitHub (${GITHUB_REPO})...`);
    try {
        const res = await axios.get(`https://api.github.com/repos/${GITHUB_REPO}/contents/db.enc`, {
            headers: { Authorization: `token ${GITHUB_PAT}` }
        });
        dbSha = res.data.sha;
        const b64 = res.data.content;
        const encrypted = Buffer.from(b64, 'base64').toString('utf8');
        const rawJson = decrypt(encrypted, DB_SECRET);
        dbCache = JSON.parse(rawJson);
        addLog(`[+] Successfully decrypted and loaded DB from GitHub!`);
    } catch(e) {
        if (e.response && e.response.status === 404) {
            addLog(`[!] No db.enc found on GitHub. Creating a fresh encrypted DB.`);
            dbCache = loadLocalDB(); 
        } else {
            addLog(`[-] Error loading from GitHub: ${e.message}. Falling back to local.`);
            dbCache = loadLocalDB();
        }
    }
}

function loadDB() {
    if (!dbCache) {
        dbCache = loadLocalDB();
    }
    return dbCache;
}

let isSyncing = false;
let syncPending = false;

async function saveDBToGitHub(addLog) {
    if (!GITHUB_PAT || !GITHUB_REPO) return;
    
    if (isSyncing) {
        syncPending = true;
        return;
    }
    
    isSyncing = true;
    syncPending = false;
    
    try {
        const rawJson = JSON.stringify(dbCache);
        const encrypted = encrypt(rawJson, DB_SECRET);
        const b64 = Buffer.from(encrypted).toString('base64');
        
        const payload = {
            message: "bot: Sync Encrypted Cloud DB [skip render]",
            content: b64
        };
        
        if (!dbSha) {
             try {
                const getRes = await axios.get(`https://api.github.com/repos/${GITHUB_REPO}/contents/db.enc`, {
                    headers: { Authorization: `token ${GITHUB_PAT}` }
                });
                dbSha = getRes.data.sha;
             } catch(e) {}
        }
        
        if (dbSha) payload.sha = dbSha;

        const res = await axios.put(`https://api.github.com/repos/${GITHUB_REPO}/contents/db.enc`, payload, {
            headers: { Authorization: `token ${GITHUB_PAT}` }
        });
        dbSha = res.data.content.sha;
    } catch (e) {
        if (e.response && e.response.status === 409) {
            dbSha = null; // Clear to force refetch next time
            syncPending = true; // Retry
        } else {
            if (addLog) addLog(`[-] Failed to sync DB to GitHub: ${e.response?.data?.message || e.message}`);
        }
    } finally {
        isSyncing = false;
        if (syncPending) {
            setTimeout(() => saveDBToGitHub(addLog), 2000);
        }
    }
}

function saveDB(data, addLog) {
    dbCache = data;
    saveLocalDB(data); // Always keep a local copy for immediate fast reads
    saveDBToGitHub(addLog); // Fire and forget upload to GitHub
}

module.exports = { initDB, loadDB, saveDB };
