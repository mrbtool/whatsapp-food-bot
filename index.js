const { Client, LocalAuth } = require('whatsapp-web.js');
const { initializeApp } = require('firebase/app');
const { getFirestore, collection, getDocs, addDoc } = require('firebase/firestore');

// ⚠️ ENTER YOUR PHONE NUMBER HERE (Country Code + Number, NO '+')
const YOUR_PHONE_NUMBER = '919863847661'; 

const firebaseConfig = {
    apiKey: "AIzaSyB7-AfV89E0OmX9jIKvhyif_Id2ivxFIs4",
    authDomain: "vido-call-bd1b3.firebaseapp.com",
    projectId: "vido-call-bd1b3",
    storageBucket: "vido-call-bd1b3.firebasestorage.app",
    messagingSenderId: "503331447116",
    appId: "1:503331447116:web:4abe4641e963a331022fe9"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// Initialize WhatsApp with VIRTUAL MONITOR + STEALTH MODE
const client = new Client({
    authStrategy: new LocalAuth(),
    webVersionCache: {
        type: 'none' // CRITICAL: Forces fresh WhatsApp version so phone doesn't reject it
    },
    puppeteer: { 
        headless: false,
        defaultViewport: null,
        args:[
            '--no-sandbox', 
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process',
            '--disable-gpu',
            '--disable-blink-features=AutomationControlled', // 🛡️ HIDES BOT STATUS FROM WHATSAPP
            '--disable-web-security',
            '--disable-features=IsolateOrigins,site-per-process'
        ] 
    },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
});

let pairingCodeRequested = false;

client.on('qr', async () => {
    if (!pairingCodeRequested) {
        pairingCodeRequested = true;
        console.log('\n=========================================================');
        console.log('⏳ REQUESTING PAIRING CODE... (Please wait 8 seconds)');
        
        // Wait longer to ensure WebSocket connection is perfectly stable
        setTimeout(async () => {
            try {
                const code = await client.requestPairingCode(YOUR_PHONE_NUMBER);
                console.log('\n🌟 YOUR PAIRING CODE IS: ' + code);
                console.log('=========================================================\n');
            } catch (error) {
                console.error('❌ Error requesting pairing code:', error);
                pairingCodeRequested = false; // Allow retry if failed
            }
        }, 8000); 
    }
});

client.on('ready', () => {
    console.log('✅ WhatsApp Bot is Ready and Live on GitHub Actions!');
});

client.on('message', async (msg) => {
    const command = msg.body.toLowerCase().trim();
    const originalText = msg.body.trim();
    const senderNumber = msg.from.replace('@c.us', ''); 

    if (command === 'hi' || command === 'hello' || command === 'menu') {
        try {
            const querySnapshot = await getDocs(collection(db, "products"));
            if (querySnapshot.empty) {
                msg.reply("Our menu is currently empty.");
                return;
            }
            let menuText = "🍔 *WELCOME*\n\n*Menu:*\n";
            querySnapshot.forEach((doc) => {
                const p = doc.data();
                menuText += `▪️ *${p.name}* - $${p.price}\n`;
            });
            menuText += "\nReply: `Order [Item Name]`";
            msg.reply(menuText);
        } catch (error) { console.error(error); }
    }
    
    else if (command.startsWith('order ')) {
        const itemToOrder = originalText.substring(6).trim();
        try {
            await addDoc(collection(db, "orders"), {
                customer: senderNumber, 
                item: itemToOrder,
                status: "Pending",     
                timestamp: new Date()
            });
            msg.reply(`✅ *Order Placed!*\nPreparing your *${itemToOrder}*.`);
        } catch (error) { console.error(error); }
    }
});

client.initialize();
