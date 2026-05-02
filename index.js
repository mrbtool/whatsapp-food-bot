const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { initializeApp } = require('firebase/app');
const { getFirestore, collection, getDocs, addDoc } = require('firebase/firestore');

// Firebase Setup
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

// Initialize WhatsApp specifically for GitHub Actions
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: { 
        headless: true,
        args:['--no-sandbox', '--disable-setuid-sandbox'] // REQUIRED FOR GITHUB ACTIONS
    }
});

client.on('qr', (qr) => {
    qrcode.generate(qr, { small: true });
    console.log('=========================================');
    console.log('📱 SCAN THE QR CODE ABOVE IN YOUR WHATSAPP!');
    console.log('=========================================');
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
