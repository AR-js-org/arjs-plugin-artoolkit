// Simple marker detection example
// Demonstrates webcam capture → ImageBitmap → ARToolKit plugin → worker detection

import { ArtoolkitPlugin } from '../../src/plugin.js';

// Simple EventBus implementation for the example
class SimpleEventBus {
    constructor() {
        this.events = {};
    }
    
    on(event, handler) {
        if (!this.events[event]) {
            this.events[event] = [];
        }
        this.events[event].push(handler);
    }
    
    off(event, handler) {
        if (!this.events[event]) return;
        this.events[event] = this.events[event].filter(h => h !== handler);
    }
    
    emit(event, data) {
        if (!this.events[event]) return;
        this.events[event].forEach(handler => handler(data));
    }
}

// Simple mock engine for the example
class SimpleEngine {
    constructor() {
        this.eventBus = new SimpleEventBus();
        this.frameId = 0;
    }
    
    update(frameData) {
        this.eventBus.emit('engine:update', frameData);
    }
}

// Console output helper
function addConsoleLog(message, type = 'info') {
    const consoleEl = document.getElementById('console');
    const line = document.createElement('div');
    line.className = `console-line ${type}`;
    line.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
    consoleEl.appendChild(line);
    consoleEl.scrollTop = consoleEl.scrollHeight;
}

// Status update helpers
function updateStatus(elementId, text, badgeClass) {
    const el = document.getElementById(elementId);
    if (el) {
        el.textContent = text;
        el.className = `badge ${badgeClass}`;
    }
}

function updateCounter(elementId, value) {
    const el = document.getElementById(elementId);
    if (el) {
        el.textContent = value;
    }
}

// Main application
class MarkerDetectionApp {
    constructor() {
        this.engine = new SimpleEngine();
        this.plugin = null;
        this.videoElement = null;
        this.stream = null;
        this.animationFrame = null;
        this.frameCount = 0;
        this.markerCount = 0;
        this.running = false;
    }
    
    async init() {
        addConsoleLog('Initializing ARToolKit plugin...', 'info');
        
        // Create and initialize the plugin
        this.plugin = new ArtoolkitPlugin({
            worker: true,
            lostThreshold: 5,
            frameDurationMs: 100
        });
        
        try {
            await this.plugin.init(this.engine);
            addConsoleLog('Plugin initialized', 'info');
            updateStatus('pluginStatus', 'Initialized', 'success');
            
            // Set up event listeners
            this.setupEventListeners();
            
            // Enable the plugin
            await this.plugin.enable();
            addConsoleLog('Plugin enabled', 'info');
        } catch (err) {
            addConsoleLog(`Failed to initialize plugin: ${err.message}`, 'error');
            updateStatus('pluginStatus', 'Failed', 'danger');
        }
    }
    
    setupEventListeners() {
        // Listen for worker ready
        this.engine.eventBus.on('ar:workerReady', () => {
            addConsoleLog('Worker is ready', 'info');
            updateStatus('workerStatus', 'Ready', 'success');
        });
        
        // Listen for marker found
        this.engine.eventBus.on('ar:markerFound', (data) => {
            this.markerCount++;
            addConsoleLog(`Marker found: ID=${data.id}, confidence=${data.confidence.toFixed(2)}`, 'info');
            updateCounter('markerCount', this.markerCount);
        });
        
        // Listen for marker updated
        this.engine.eventBus.on('ar:markerUpdated', (data) => {
            // Log only occasionally to avoid spam
            if (this.frameCount % 30 === 0) {
                addConsoleLog(`Marker updated: ID=${data.id}, confidence=${data.confidence.toFixed(2)}`, 'info');
            }
        });
        
        // Listen for marker lost
        this.engine.eventBus.on('ar:markerLost', (data) => {
            addConsoleLog(`Marker lost: ID=${data.id}`, 'warn');
        });
        
        // Listen for worker errors
        this.engine.eventBus.on('ar:workerError', (data) => {
            addConsoleLog(`Worker error: ${data.message}`, 'error');
        });
    }
    
    async startCamera() {
        try {
            addConsoleLog('Requesting camera access...', 'info');
            
            // Get video element
            this.videoElement = document.getElementById('video');
            
            // Request camera stream
            this.stream = await navigator.mediaDevices.getUserMedia({
                video: {
                    width: { ideal: 640 },
                    height: { ideal: 480 },
                    facingMode: 'environment'
                }
            });
            
            this.videoElement.srcObject = this.stream;
            await this.videoElement.play();
            
            addConsoleLog('Camera started', 'info');
            updateStatus('cameraStatus', 'Running', 'success');
            
            // Start processing frames
            this.running = true;
            this.processFrame();
            
            // Update button states
            document.getElementById('startBtn').disabled = true;
            document.getElementById('stopBtn').disabled = false;
        } catch (err) {
            addConsoleLog(`Failed to start camera: ${err.message}`, 'error');
            updateStatus('cameraStatus', 'Failed', 'danger');
        }
    }
    
    stopCamera() {
        this.running = false;
        
        if (this.animationFrame) {
            cancelAnimationFrame(this.animationFrame);
            this.animationFrame = null;
        }
        
        if (this.stream) {
            this.stream.getTracks().forEach(track => track.stop());
            this.stream = null;
        }
        
        if (this.videoElement) {
            this.videoElement.srcObject = null;
        }
        
        addConsoleLog('Camera stopped', 'info');
        updateStatus('cameraStatus', 'Stopped', 'warning');
        
        // Update button states
        document.getElementById('startBtn').disabled = false;
        document.getElementById('stopBtn').disabled = true;
    }
    
    async processFrame() {
        if (!this.running) return;
        
        try {
            // Create ImageBitmap from video
            const imageBitmap = await createImageBitmap(this.videoElement);
            
            this.frameCount++;
            updateCounter('frameCount', this.frameCount);
            
            // Send frame to plugin/worker via engine update
            this.engine.update({
                id: this.frameCount,
                timestamp: Date.now(),
                imageBitmap: imageBitmap,
                width: imageBitmap.width,
                height: imageBitmap.height
            });
            
            // Note: ImageBitmap is transferred to worker and will be closed there
            // We should not use it after this point
        } catch (err) {
            // Log errors only occasionally to avoid spam
            if (this.frameCount % 100 === 0) {
                addConsoleLog(`Frame processing error: ${err.message}`, 'error');
            }
        }
        
        // Schedule next frame (approximately 30 FPS)
        this.animationFrame = setTimeout(() => {
            requestAnimationFrame(() => this.processFrame());
        }, 1000 / 30);
    }
}

// Initialize app when page loads
let app = null;

window.addEventListener('DOMContentLoaded', async () => {
    addConsoleLog('Page loaded', 'info');
    
    // Initialize the app
    app = new MarkerDetectionApp();
    await app.init();
    
    // Set up button handlers
    document.getElementById('startBtn').addEventListener('click', () => {
        app.startCamera();
    });
    
    document.getElementById('stopBtn').addEventListener('click', () => {
        app.stopCamera();
    });
    
    addConsoleLog('Ready. Click "Start Camera" to begin.', 'info');
});

// Clean up on page unload
window.addEventListener('beforeunload', () => {
    if (app) {
        app.stopCamera();
        if (app.plugin) {
            app.plugin.disable();
        }
    }
});
