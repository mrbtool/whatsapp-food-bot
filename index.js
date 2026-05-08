const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const readline = require('readline');

// 🌟 SECURE FIREBASE URL FROM GITHUB SECRETS 🌟
const FIREBASE_URL = process.env.FIREBASE_URL;

const orderStates = {}; 

// Helper function to read terminal input (Phone Number)
const question = (text) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
        rl.question(text, (answer) => {
            rl.close();
            resolve(answer);
        });
    });
};

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
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        // For pairing codes, it's recommended to use a standard browser profile
        browser:["Ubuntu", "Chrome", "20.0.04"] 
    });

    // 🌟 REQUEST PAIRING CODE IF NOT LOGGED IN 🌟
    if (!sock.authState.creds.registered) {
        console.log('\n==================================================');
        const phoneNumber = await question('📱 Enter your Bot WhatsApp Number (with country code, e.g. 919876543210): ');
        const cleanNumber = phoneNumber.replace(/[^0-9]/g, ''); // Remove any +, spaces, or dashes
        
        setTimeout(async () => {
            try {
                let code = await sock.requestPairingCode(cleanNumber);
                code = code?.match(/.{1,4}/g)?.join("-") || code; // Format as XXXX-XXXX
                console.log('\n==================================================');
                console.log(`🔑 YOUR PAIRING CODE IS: ${code}`);
                console.log('==================================================');
                console.log(`📌 Steps to link:`);
                console.log(`1. Open WhatsApp on your phone.`);
                console.log(`2. Tap 3 dots (Menu) > Linked Devices > Link a Device.`);
                console.log(`3. Tap "Link with phone number instead" at the bottom.`);
                console.log(`4. Enter the code above.`);
                console.log('==================================================\n');
            } catch (err) {
                console.log('❌ Error requesting pairing code:', err.message);
            }
        }, 2000);
    }

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'open') console.log('✅ MRBUSH AI IS ONLINE!');
        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            if (reason !== DisconnectReason.loggedOut) {
                console.log('🔄 Reconnecting...');
                startBot();
            } else {
                console.log('❌ Logged out. Please delete the session_data folder and restart.');
            }
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
            const customerDetails = text; 
            const item = orderStates[sender].item;
            const customerWaNumber = sender.split('@')[0];

            const mrBushOrder = {
                userId: "whatsapp_" + customerWaNumber,
                userEmail: "whatsapp@mrbush.com",
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

            try {
                await fetch(`${FIREBASE_URL}/orders.json`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(mrBushOrder)
                });
            } catch (error) {
                console.log("Firebase Error: ", error);
            }

            await sock.sendMessage(sender, { text: `✅ *Order Placed Successfully!* \n\nThank you! Your order for *${item.name}* is being prepared. \n\n*Total:* ₹${mrBushOrder.total} (Inc. Delivery)\n*Phone Linked:* +${customerWaNumber}\n*Status:* Preparing\n\nWe will deliver it to your address soon.` });
            delete orderStates[sender]; 
            return;
        }

        // --- 🌟 STEP 1: START ORDER FLOW ---
        if (text.startsWith("order ")) {
            const productRequested = text.replace("order ", "").trim().toLowerCase();
            const currentMenu = await getMenuFromApp();
            
            const matchedItem = currentMenu.find(item => item.name.toLowerCase().includes(productRequested));

            if (!matchedItem) {
                await sock.sendMessage(sender, { text: `❌ Sorry, we couldn't find *${productRequested}* in our menu today.\n\nType *menu* to see all available items.` });
                return;
            }

            orderStates[sender] = { step: 'WAITING_FOR_ADDRESS', item: matchedItem };
            
            const captionText = `🛒 *Order Started!* \n\nYou selected: *${matchedItem.name}* (₹${matchedItem.price})\n\n📍 Please reply with your *Full Name and Delivery Address*.\n_(We will automatically use your WhatsApp number to contact you)_`;
            
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

            let menuMessage = "🍔 *MRBUSH LIVE MENU* 🍕\n\n";
            currentMenu.forEach(item => {
                menuMessage += `🔸 *${item.name}* - ₹${item.price}\n`;
            });
            menuMessage += "\n_To order, reply with 'order [dish name]'_";
            
            await sock.sendMessage(sender, { text: menuMessage });
        }

        // --- GREETINGS ---
        else if (text.includes("hi") || text.includes("hello") || text.includes("hey")) {
            await sock.sendMessage(sender, { text: "👋 *Welcome to MrBush!* \n\nI am your AI Assistant. Type *menu* to see our delicious food, or type *order[dish]* to buy instantly!" });
        }
        else if (text.includes("contact") || text.includes("call")) {
            await sock.sendMessage(sender, { text: "📞 *Contact MrBush:* \n\n- *Email:* support@mrbush.com" });
        }
        else {
            await sock.sendMessage(sender, { text: "🤔 I didn't quite catch that.\n\nType *menu* to see our food list, or *order [food]* to place an order!" });
        }
    });
}

startBot().catch(err => console.log("Error: " + err));
