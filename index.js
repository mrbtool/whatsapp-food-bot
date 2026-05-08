const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');

// 🌟 SECURE FIREBASE URL FROM GITHUB SECRETS 🌟
const FIREBASE_URL = process.env.FIREBASE_URL;

const orderStates = {}; 

// Tracker for repeated messages (Anti-Spam)
const userSpamTracker = {};
const SPAM_RESET_TIME_MS = 60 * 1000; // 1 minute window for tracking messages

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
        browser: ["S", "K", "1"],
        // 🌟 CHANGE 2: PREVENT LOGIN EXPIRE & CONNECTION DROPS 🌟
        keepAliveIntervalMs: 30000,   // Sends ping every 30s to keep connection alive indefinitely
        markOnlineOnConnect: true,    // Keeps the bot marked as online
        defaultQueryTimeoutMs: 60000  // Prevents sudden timeouts
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=500x500&data=${encodeURIComponent(qr)}`;
            
            console.clear(); 
            console.log('\n==================================================');
            console.log('🔗 SCAN THIS QR CODE TO LOGIN:');
            console.log('Click or copy the link below in your browser:');
            console.log(qrImageUrl);
            console.log('==================================================\n');
        }

        if (connection === 'open') console.log('✅ MRBUSH AI IS ONLINE!');
        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            
            // Reconnect automatically if it's not a manual logout
            if (reason !== DisconnectReason.loggedOut) {
                console.log('⚠️ Connection lost, reconnecting safely...');
                setTimeout(startBot, 3000); // 3-second delay prevents crash loops
            } else {
                console.log('❌ Device Logged Out. Please delete the "session_data" folder and scan the QR again.');
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

        // --- 🌟 CHANGE 1: SPAM/MESSAGE COUNTER LOGIC 🌟 ---
        const now = Date.now();
        if (!userSpamTracker[sender]) {
            userSpamTracker[sender] = { count: 1, lastMessage: now };
        } else {
            // Reset the counter if they haven't sent a message for 1 minute
            if (now - userSpamTracker[sender].lastMessage > SPAM_RESET_TIME_MS) {
                userSpamTracker[sender].count = 1;
            } else {
                userSpamTracker[sender].count++;
            }
            userSpamTracker[sender].lastMessage = now;
        }

        const msgCount = userSpamTracker[sender].count;
        
        // If they send 3 or 4 messages rapidly
        if (msgCount === 3 || msgCount === 4) {
            await sock.sendMessage(sender, { 
                text: "ka·sa pa·e na·a changni chang message ka·anabe emergency nangode call ka·bo!" 
            });
            return; // Block processing of this current message
        } 
        // If they keep spamming (5+ messages), ignore them silently until 1-minute timeout resets
        else if (msgCount > 4) {
            return; 
        }
        // --------------------------------------------------

        // --- 🛒 STEP 2: FINISH ORDER & SEND TO ADMIN PANEL ---
        if (orderStates[sender]?.step === 'WAITING_FOR_ADDRESS') {
            const customerDetails = text; // This now contains Name, Phone, and Address
            const item = orderStates[sender].item;
            const customerWaNumber = sender.split('@')[0];

            // Match the exact format of your MrBush Admin Panel
            const mrBushOrder = {
                userId: "whatsapp_" + customerWaNumber,
                userEmail: "whatsapp@mrbush.com",
                phone: customerWaNumber, // Keeps their WA number registered
                address: customerDetails, // Saves Name, Phone, and Address typed by them
                location: { lat: 0, lng: 0 },
                items:[{
                    id: item.id,
                    name: item.name,
                    price: parseFloat(item.price),
                    img: item.imageUrl || "",
                    quantity: 1
                }],
                total: (parseFloat(item.price) + 50).toFixed(2), // Price + 50 Delivery Fee
                status: "Placed",
                method: "Cash on Delivery (WhatsApp)",
                timestamp: new Date().toISOString()
            };

            // Save order securely via REST API
            try {
                await fetch(`${FIREBASE_URL}/orders.json`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(mrBushOrder)
                });
            } catch (error) {
                console.log("Firebase Error: ", error);
            }

            await sock.sendMessage(sender, { text: `✅ *Order Placed Successfully!* \n\nThank you! Your order for *${item.name}* is being prepared. \n\n*Total:* ₹${mrBushOrder.total} (Inc. Delivery)\n*Status:* Preparing\n\nWe will deliver it to your address soon.` });
            delete orderStates[sender]; 
            return;
        }

        // --- 🌟 STEP 1: START ORDER FLOW (WITH IMAGE & PHONE REQUEST) ---
        if (text.startsWith("order ")) {
            const productRequested = text.replace("order ", "").trim().toLowerCase();
            const currentMenu = await getMenuFromApp();
            
            // Search the live database for the requested item
            const matchedItem = currentMenu.find(item => item.name.toLowerCase().includes(productRequested));

            if (!matchedItem) {
                await sock.sendMessage(sender, { text: `❌ Sorry, we couldn't find *${productRequested}* in our menu today.\n\nType *menu* to see all available items.` });
                return;
            }

            orderStates[sender] = { step: 'WAITING_FOR_ADDRESS', item: matchedItem };
            
            // SEND PRODUCT IMAGE + ASK FOR PHONE NUMBER
            const captionText = `🛒 *Order Started!* \n\nYou selected: *${matchedItem.name}* (₹${matchedItem.price})\n\nPlease reply with your *Full Name, Phone Number, and Delivery Address*.`;
            
            // If the product has an image URL in Firebase, send it as a WhatsApp Photo
            if (matchedItem.imageUrl) {
                await sock.sendMessage(sender, { 
                    image: { url: matchedItem.imageUrl }, 
                    caption: captionText 
                });
            } else {
                // Fallback if no image is found
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
            await sock.sendMessage(sender, { 
              text: "📱 *Hi i am Walter security guard!* \n\nDa·o WALTER dongja bia ia message ko nikode reply ka·aigen jajrengna·be!"
            });
        }
        else if (text.includes("contact") || text.includes("call")) {
            await sock.sendMessage(sender, { text: "📞 *Contact MrBush:* \n\n- *Email:* support@mrbush.com" });
        }
        else {
            await sock.sendMessage(sender, { 
              text: "🤔 Hello anga Walter ni AI assistant.\n\nDa·o Angni Boss dongja jeni somoioba angni Boss ia message ko nikode reply ka·aigen jajrengna·be!" 
            });
        }
    });
}

startBot().catch(err => console.log("Error: " + err));
