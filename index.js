const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const readline = require('readline'); // 🌟 ADDED FOR TERMINAL INPUT 🌟

// 🌟 SECURE FIREBASE URL FROM GITHUB SECRETS 🌟
const FIREBASE_URL = process.env.FIREBASE_URL;

const orderStates = {}; 

// Create an interface to read the phone number from the terminal
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (text) => new Promise((resolve) => rl.question(text, resolve));

// Function to fetch the dynamic menu from your App's Firebase
async function getMenuFromApp() {
    try {
        const response = await fetch(`${FIREBASE_URL}/dishes.json`);
        const data = await response.json();
        if (!data) return[];
        
        // Convert Firebase object into an array (now includes imageUrl)
        return Object.keys(data).map(key => ({
            id: key,
            name: data[key].name,
            price: data[key].price,
            imageUrl: data[key].imageUrl
        }));
    } catch (error) {
        console.error("Failed to fetch menu:", error);
        return[];
    }
}

async function startBot() {
    if (!FIREBASE_URL) {
        console.log("❌ ERROR: FIREBASE_URL is missing in GitHub Secrets!");
        process.exit(1);
    }

    const { state, saveCreds } = await useMultiFileAuthState('session_data');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false, // 🌟 DISABLED QR CODE 🌟
        logger: pino({ level: 'silent' }),
        // 🌟 IMPORTANT: Browser must be set like this for Pairing Code to work! 🌟
        browser:["Ubuntu", "Chrome", "20.0.04"] 
    });

    // --- 🌟 PAIRING CODE LOGIC (LINK VIA MOBILE NUMBER) 🌟 ---
    if (!sock.authState.creds.registered) {
        const phoneNumber = await question('📞 Enter your WhatsApp Number (with country code, e.g., 919876543210): ');
        
        setTimeout(async () => {
            try {
                let code = await sock.requestPairingCode(phoneNumber.replace(/[^0-9]/g, ''));
                code = code?.match(/.{1,4}/g)?.join("-") || code; // Format as XXXX-XXXX
                console.clear();
                console.log('\n==================================================');
                console.log(`🔢 YOUR WA PAIRING CODE IS: ${code}`);
                console.log('Open WhatsApp -> Linked Devices -> Link with phone number');
                console.log('==================================================\n');
            } catch (err) {
                console.log('❌ Failed to request pairing code. Ensure number is correct.');
            }
        }, 3000); // Small delay to ensure socket is ready
    }

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        
        if (connection === 'open') console.log('✅ JAVAGOAT AI IS ONLINE!');
        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            if (reason !== DisconnectReason.loggedOut) startBot();
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast') return;
        if (msg.key.fromMe) return; // Loop Protection

        const sender = msg.key.remoteJid;
        const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").toLowerCase();

        console.log(`📩 Query: ${text}`);

        // --- 🛒 STEP 2: FINISH ORDER & SEND TO ADMIN PANEL ---
        if (orderStates[sender]?.step === 'WAITING_FOR_ADDRESS') {
            const customerDetails = text; // This now contains Name, Phone, and Address
            const item = orderStates[sender].item;
            const customerWaNumber = sender.split('@')[0];

            // Match the exact format of your JavaGoat Admin Panel
            const javaGoatOrder = {
                userId: "whatsapp_" + customerWaNumber,
                userEmail: "whatsapp@javagoat.com",
                phone: customerWaNumber, 
                address: customerDetails, 
                location: { lat: 0, lng: 0 },
                items:[{
                    id: item.id,
                    name: item.name,
                    price: parseFloat(item.price),
                    img: item.imageUrl || "",
                    quantity: 1
                }],
                total: (parseFloat(item.price) + 50).toFixed(2), 
                status: "Placed",
                method: "Cash on Delivery (WhatsApp)",
                timestamp: new Date().toISOString()
            };

            // Save order securely via REST API
            try {
                await fetch(`${FIREBASE_URL}/orders.json`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(javaGoatOrder)
                });
            } catch (error) {
                console.log("Firebase Error: ", error);
            }

            await sock.sendMessage(sender, { text: `✅ *Order Placed Successfully!* \n\nThank you! Your order for *${item.name}* is being prepared. \n\n*Total:* ₹${javaGoatOrder.total} (Inc. Delivery)\n*Status:* Preparing\n\nWe will deliver it to your address soon.` });
            delete orderStates[sender]; 
            return;
        }

        // --- 🌟 STEP 1: START ORDER FLOW (WITH IMAGE & PHONE REQUEST) ---
        if (text.startsWith("order ")) {
            const productRequested = text.replace("order ", "").trim().toLowerCase();
            const currentMenu = await getMenuFromApp();
            
            const matchedItem = currentMenu.find(item => item.name.toLowerCase().includes(productRequested));

            if (!matchedItem) {
                await sock.sendMessage(sender, { text: `❌ Sorry, we couldn't find *${productRequested}* in our menu today.\n\nType *menu* to see all available items.` });
                return;
            }

            orderStates[sender] = { step: 'WAITING_FOR_ADDRESS', item: matchedItem };
            
            const captionText = `🛒 *Order Started!* \n\nYou selected: *${matchedItem.name}* (₹${matchedItem.price})\n\nPlease reply with your *Full Name, Phone Number, and Delivery Address*.`;
            
            if (matchedItem.imageUrl) {
                await sock.sendMessage(sender, { 
                    image: { url: matchedItem.imageUrl }, 
                    caption: captionText 
                });
            } else {
                await sock.sendMessage(sender, { text: captionText });
            }
        }
        else if (text === "order") { 
            await sock.sendMessage(sender, { text: "🛒 *How to order:* \nPlease type 'order' followed by the dish name. \nExample: *order pizza*" });
        }
        
        // --- DYNAMIC MENU FEATURE ---
        else if (text.includes("menu") || text.includes("price") || text.includes("list") || text.includes("food")) {
            const currentMenu = await getMenuFromApp();
            
            if (currentMenu.length === 0) {
                await sock.sendMessage(sender, { text: "Our menu is currently empty or updating. Please check back soon!" });
                return;
            }

            let menuMessage = "🍔 *JAVAGOAT LIVE MENU* 🍕\n\n";
            currentMenu.forEach(item => {
                menuMessage += `🔸 *${item.name}* - ₹${item.price}\n`;
            });
            menuMessage += "\n_To order, reply with 'order[dish name]'_";
            
            await sock.sendMessage(sender, { text: menuMessage });
        }

        // --- GREETINGS ---
        else if (text.includes("hi") || text.includes("hello") || text.includes("hey")) {
            await sock.sendMessage(sender, { text: "👋 *Welcome to JavaGoat!* \n\nI am your AI Assistant. Type *menu* to see our delicious food, or type *order [dish]* to buy instantly!" });
        }
        else if (text.includes("contact") || text.includes("call")) {
            await sock.sendMessage(sender, { text: "📞 *Contact JavaGoat:* \n\n- *Email:* support@javagoat.com" });
        }
        else {
            await sock.sendMessage(sender, { text: "🤔 I didn't quite catch that.\n\nType *menu* to see our food list, or *order [food]* to place an order!" });
        }
    });
}

startBot().catch(err => console.log("Error: " + err));            '--disable-gpu',
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
