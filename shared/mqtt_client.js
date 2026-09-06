// ============================================================
// WardOS - MQTT Client Manager
// File: shared/mqtt_client.js
//
// Responsibilities:
// - Connect to MQTT broker over WebSocket
// - Subscribe to WardOS topics
// - Queue incoming messages
// - Process messages outside the MQTT callback
// - Handle reconnects with backoff
// - Detect RAW mode when clean telemetry stops
// - Dispatch MQTT status events to the UI
// - Support simulation mode
//
// IMPORTANT:
// This is the ONLY module that should directly communicate
// with MQTT.
// ============================================================

import { config } from "./config.js";
import { stateStore } from "./state_store.js";
import { historyStore } from "./history_store.js";


// ============================================================
// MQTT CLIENT MANAGER
// ============================================================

export class MqttClientManager {

    constructor() {

        // --------------------------------------------------------
        // Connection
        // --------------------------------------------------------

        this.client = null;

        this.status = "OFFLINE";

        this.connecting = false;

        this.reconnectTimer = null;

        this.reconnectAttempts = 0;


        // --------------------------------------------------------
        // Message processing
        // --------------------------------------------------------

        this.messageQueue = [];

        this.maxMessagesPerTick = 50;


        // --------------------------------------------------------
        // Telemetry monitoring
        // --------------------------------------------------------

        this.lastCleanMessageTime = Date.now();

        this.isRawMode = false;


        // --------------------------------------------------------
        // Simulation
        // --------------------------------------------------------

        this.simulationMode = false;


        // --------------------------------------------------------
        // Start background workers
        // --------------------------------------------------------

        // Process MQTT messages every 50ms.
        //
        // We deliberately DON'T process messages directly inside
        // the MQTT WebSocket callback.
        //
        // This prevents heavy UI/state processing from blocking
        // the WebSocket event loop.
        //
        this.queueTimer = setInterval(() => {
            this.processQueue();
        }, 50);


        // Check whether clean telemetry has stopped.
        //
        // If clean telemetry is silent for >10 seconds,
        // WardOS enters RAW MODE.
        //
        this.rawModeTimer = setInterval(() => {
            this.checkRawMode();
        }, 2000);
    }


    // ==========================================================
    // STATUS MANAGEMENT
    // ==========================================================

    updateStatus(newStatus) {

        if (this.status === newStatus) {
            return;
        }

        this.status = newStatus;

        console.log(`[WardOS MQTT] ${newStatus}`);

        // Notify the rest of the application.
        //
        // nurse_dashboard.js / doctor_dashboard.js can listen for:
        //
        // window.addEventListener("mqtt-status", ...)
        //
        window.dispatchEvent(
            new CustomEvent("mqtt-status", {
                detail: newStatus
            })
        );
    }


    // ==========================================================
    // GET CURRENT STATUS
    // ==========================================================

    getStatus() {
        return this.status;
    }


    // ==========================================================
    // CONNECT
    // ==========================================================

    connect() {

        // Prevent duplicate connections.
        if (this.client || this.connecting) {
            return;
        }


        // --------------------------------------------------------
        // Check MQTT.js
        // --------------------------------------------------------

        const mqttLibrary = window.mqtt;

        if (!mqttLibrary) {

            console.warn(
                "[WardOS MQTT] MQTT.js not loaded. " +
                "Simulation mode recommended."
            );

            this.simulationMode = true;

            this.updateStatus("OFFLINE");

            return;
        }


        // --------------------------------------------------------
        // Build WebSocket URL
        // --------------------------------------------------------

        const broker = config.mqtt.broker;

        const wsPort = config.mqtt.wsPort;

        const url =
            `ws://${broker}:${wsPort}/mqtt`;


        console.log(
            `[WardOS MQTT] Connecting to ${url}`
        );


        this.connecting = true;

        this.updateStatus("CONNECTING");


        // --------------------------------------------------------
        // Create MQTT client
        // --------------------------------------------------------

        try {

            this.client = mqttLibrary.connect(url, {

                // Manual reconnect.
                reconnectPeriod: 0,

                // MQTT keepalive.
                keepalive: config.mqtt.keepAlive,

                // Clean session.
                clean: true
            });


        } catch (error) {

            console.error(
                "[WardOS MQTT] Connection creation failed:",
                error
            );

            this.client = null;

            this.connecting = false;

            this.updateStatus("OFFLINE");

            this.scheduleReconnect();

            return;
        }


        // ========================================================
        // CONNECT EVENT
        // ========================================================

        this.client.on("connect", () => {

            console.log(
                "[WardOS MQTT] Broker connected"
            );


            this.connecting = false;

            this.reconnectAttempts = 0;

            this.simulationMode = false;

            this.isRawMode = false;

            this.lastCleanMessageTime = Date.now();


            this.updateStatus("CONNECTED");


            // ----------------------------------------------------
            // Subscribe to clean telemetry
            // ----------------------------------------------------

            this.subscribe(
                config.mqtt.cleanTopic
            );


            // ----------------------------------------------------
            // Subscribe to raw telemetry
            // ----------------------------------------------------

            this.subscribe(
                config.mqtt.rawTopic
            );
        });


        // ========================================================
        // MESSAGE EVENT
        // ========================================================

        this.client.on(
            "message",
            (topic, message) => {

                try {

                    const text =
                        message.toString();

                    const payload =
                        JSON.parse(text);


                    // ------------------------------------------------
                    // Queue the message.
                    //
                    // DO NOT update the state store here.
                    // ------------------------------------------------

                    this.messageQueue.push({
                        topic,
                        payload
                    });


                } catch (error) {

                    console.error(
                        "[WardOS MQTT] Invalid MQTT payload:",
                        error
                    );
                }
            }
        );


        // ========================================================
        // CLOSE EVENT
        // ========================================================

        this.client.on("close", () => {

            console.warn(
                "[WardOS MQTT] Connection closed"
            );


            this.client = null;

            this.connecting = false;

            this.updateStatus("OFFLINE");


            this.scheduleReconnect();
        });


        // ========================================================
        // ERROR EVENT
        // ========================================================

        this.client.on("error", (error) => {

            console.error(
                "[WardOS MQTT] MQTT error:",
                error
            );


            // Do NOT create another connection here.
            //
            // The close event will handle cleanup and
            // reconnection.
        });


        // ========================================================
        // OFFLINE EVENT
        // ========================================================

        this.client.on("offline", () => {

            console.warn(
                "[WardOS MQTT] MQTT client offline"
            );

            this.updateStatus("OFFLINE");
        });
    }


    // ==========================================================
    // SUBSCRIBE
    // ==========================================================

    subscribe(topic) {

        if (!this.client) {
            console.warn(
                "[WardOS MQTT] Cannot subscribe. " +
                "MQTT client unavailable."
            );

            return;
        }


        this.client.subscribe(
            topic,
            { qos: 0 },
            (error) => {

                if (error) {

                    console.error(
                        `[WardOS MQTT] Failed to subscribe: ${topic}`,
                        error
                    );

                    return;
                }


                console.log(
                    `[WardOS MQTT] Subscribed: ${topic}`
                );
            }
        );
    }


    // ==========================================================
    // MESSAGE QUEUE PROCESSOR
    // ==========================================================

    processQueue() {

        if (
            this.messageQueue.length === 0
        ) {
            return;
        }


        // Process a maximum number of messages
        // during one tick.
        const batch =
            this.messageQueue.splice(
                0,
                this.maxMessagesPerTick
            );


        for (const item of batch) {

            const {
                topic,
                payload
            } = item;


            try {

                // ------------------------------------------------
                // CLEAN TELEMETRY
                // ------------------------------------------------

                if (
                    topic ===
                    config.mqtt.cleanTopic
                ) {

                    this.lastCleanMessageTime =
                        Date.now();


                    // If RAW MODE was active and clean
                    // telemetry has returned, restore
                    // normal status.
                    if (this.isRawMode) {

                        this.isRawMode = false;

                        this.updateStatus(
                            "CONNECTED"
                        );
                    }
                }


                // ------------------------------------------------
                // Attach topic to payload
                // ------------------------------------------------

                payload.topic = topic;


                // ------------------------------------------------
                // Update central state
                // ------------------------------------------------

                stateStore.updateState(
                    payload
                );


                // ------------------------------------------------
                // Store historical sample
                // ------------------------------------------------

                if (
                    payload.device_id !==
                    undefined &&
                    payload.device_id !==
                    null
                ) {

                    historyStore.addSample(
                        payload.device_id,
                        payload,
                        topic
                    );
                }


            } catch (error) {

                console.error(
                    "[WardOS MQTT] Error processing message:",
                    error
                );
            }
        }
    }


    // ==========================================================
    // RAW MODE DETECTION
    // ==========================================================

    checkRawMode() {

        // Nothing to check if completely offline.
        if (
            this.status === "OFFLINE" ||
            this.status === "CONNECTING"
        ) {
            return;
        }


        const timeSinceLastClean =
            Date.now() -
            this.lastCleanMessageTime;


        // --------------------------------------------------------
        // Clean telemetry silent for >10 seconds
        // --------------------------------------------------------

        if (
            timeSinceLastClean > 10000 &&
            !this.isRawMode
        ) {

            this.isRawMode = true;


            console.warn(
                "[WardOS MQTT] Clean telemetry silent >10s. RAW MODE."
            );


            this.updateStatus(
                "RAW MODE"
            );
        }
    }


    // ==========================================================
    // RECONNECT
    // ==========================================================

    scheduleReconnect() {

        // Don't create multiple timers.
        if (this.reconnectTimer) {
            return;
        }


        // --------------------------------------------------------
        // Exponential backoff
        //
        // Attempt 1 → 2 seconds
        // Attempt 2 → 4 seconds
        // Attempt 3 → 8 seconds
        // ...
        //
        // Maximum → configured reconnect delay / safe limit
        // --------------------------------------------------------

        this.reconnectAttempts++;


        const baseDelay =
            config.mqtt.reconnectDelay || 3000;


        const delay =
            Math.min(
                baseDelay *
                Math.pow(
                    2,
                    Math.min(
                        this.reconnectAttempts - 1,
                        5
                    )
                ),
                30000
            );


        console.log(
            `[WardOS MQTT] Reconnecting in ${delay / 1000}s...`
        );


        this.reconnectTimer =
            setTimeout(() => {

                this.reconnectTimer = null;

                this.connect();

            }, delay);
    }


    // ==========================================================
    // MANUAL DISCONNECT
    // ==========================================================

    disconnect() {

        console.log(
            "[WardOS MQTT] Manual disconnect"
        );


        // Cancel reconnect timer.
        if (this.reconnectTimer) {

            clearTimeout(
                this.reconnectTimer
            );

            this.reconnectTimer = null;
        }


        // Reset connection flags.
        this.connecting = false;

        this.reconnectAttempts = 0;


        // Close MQTT connection.
        if (this.client) {

            try {

                this.client.end(
                    true
                );

            } catch (error) {

                console.error(
                    "[WardOS MQTT] Disconnect error:",
                    error
                );
            }
        }


        this.client = null;

        this.updateStatus(
            "OFFLINE"
        );
    }


    // ==========================================================
    // SIMULATION SUPPORT
    // ==========================================================

    handleSimulatedMessage(
        topic,
        payload
    ) {

        // Simulation messages follow the
        // exact same processing pipeline as
        // real MQTT messages.

        this.messageQueue.push({
            topic,
            payload
        });
    }


    // ==========================================================
    // ENABLE SIMULATION MODE
    // ==========================================================

    enableSimulation() {

        console.log(
            "[WardOS MQTT] Simulation mode enabled."
        );


        this.simulationMode = true;

        this.updateStatus(
            "SIMULATION"
        );
    }


    // ==========================================================
    // GET CONNECTION INFORMATION
    // ==========================================================

    getConnectionInfo() {

        return {

            status: this.status,

            connected:
                !!this.client,

            simulation:
                this.simulationMode,

            rawMode:
                this.isRawMode,

            queuedMessages:
                this.messageQueue.length,

            reconnectAttempts:
                this.reconnectAttempts
        };
    }
}


// ============================================================
// SINGLETON INSTANCE
// ============================================================
//
// Every dashboard imports this same instance:
//
// import { mqttClient } from "../shared/mqtt_client.js";
//
// This prevents multiple MQTT managers from being created.
// ============================================================

export const mqttClient =
    new MqttClientManager();