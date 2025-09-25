#!/usr/bin/env node
/**
 * Codex HTTP Server with JSON-RPC support and SSE streaming.
 * Compatible with n8n, CapRover deployment, and HTTP streaming clients.
 * 
 * Provides HTTP API endpoints for OpenAI Codex CLI with real-time streaming support.
 */

const http = require('http');
const url = require('url');
const querystring = require('querystring');
const { spawn } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs').promises;

// Configuration
const PORT = parseInt(process.env.PORT || '8000');
const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || '/workspace';
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const MAX_CONCURRENT_TASKS = parseInt(process.env.MAX_CONCURRENT_TASKS || '5');
const AUTH_KEY = process.env.CODEX_SERVER_AUTH_KEY || null;

// Debug: Check for OpenAI API Key availability
const apiKeyPreview = process.env.OPENAI_API_KEY
    ? `sk-...${process.env.OPENAI_API_KEY.slice(-4)}`
    : 'Not found';
console.log(`[DEBUG] Initial OPENAI_API_KEY check: ${apiKeyPreview}`);

// Global state
const activeTasks = new Map();
const taskStreams = new Map();

// Logging utility
const logger = {
    info: (msg, ...args) => LOG_LEVEL !== 'silent' && console.log(`[INFO] ${msg}`, ...args),
    error: (msg, ...args) => console.error(`[ERROR] ${msg}`, ...args),
    warn: (msg, ...args) => console.warn(`[WARN] ${msg}`, ...args),
    debug: (msg, ...args) => LOG_LEVEL === 'debug' && console.log(`[DEBUG] ${msg}`, ...args)
};

// Stream event class for SSE
class StreamEvent {
    constructor(type, taskId, data = {}) {
        this.type = type;
        this.task_id = taskId;
        this.timestamp = new Date().toISOString();
        this.data = data;
    }

    toSSE() {
        return `data: ${JSON.stringify(this)}\n\n`;
    }
}

// Utility functions
async function ensureDirectory(dirPath) {
    try {
        await fs.mkdir(dirPath, { recursive: true });
        return true;
    } catch (error) {
        logger.error(`Failed to create directory ${dirPath}:`, error);
        return false;
    }
}

async function setupWorkspace() {
    logger.info(`Setting up workspace at: ${WORKSPACE_ROOT}`);
    
    await ensureDirectory(WORKSPACE_ROOT);
    await ensureDirectory(path.join(WORKSPACE_ROOT, 'projects'));
    await ensureDirectory(path.join(WORKSPACE_ROOT, 'temp'));
    
    // Setup Codex authentication
    await setupCodexAuth();
    
    // Setup configured MCP tools
    await setupMcpTools();

    logger.info('Workspace initialized successfully');
}

async function setupMcpTools() {
    logger.info('Checking for MCP tool configurations...');
    const mcpToolEnvs = Object.entries(process.env).filter(([key]) => key.startsWith('MCP_TOOL_'));

    if (mcpToolEnvs.length === 0) {
        logger.info('No MCP tools configured via environment variables.');
        return;
    }

    for (const [key, value] of mcpToolEnvs) {
        const toolName = key.replace('MCP_TOOL_', '').toLowerCase();
        const commandParts = value.split(' ');
        const command = commandParts[0];
        const args = commandParts.slice(1);

        if (!toolName || !command) {
            logger.warn(`Skipping invalid MCP tool configuration: ${key}`);
            continue;
        }

        logger.info(`Registering MCP tool '${toolName}' with command: ${value}`);

        const commandArgs = ['mcp', 'add', toolName, '--', command, ...args];

        await new Promise((resolve, reject) => {
            const addProcess = spawn('codex', commandArgs, {
                env: {
                    ...process.env,
                    HOME: WORKSPACE_ROOT,
                    CODEX_HOME: path.join(WORKSPACE_ROOT, '.codex'),
                    XDG_CONFIG_HOME: path.join(WORKSPACE_ROOT, '.config'),
                    XDG_DATA_HOME: path.join(WORKSPACE_ROOT, '.local/share'),
                },
                stdio: 'pipe'
            });
            
            let stderr = '';
            addProcess.stderr.on('data', (data) => {
                stderr += data.toString();
            });

            addProcess.on('close', (code) => {
                if (code === 0) {
                    logger.info(`Successfully registered MCP tool '${toolName}'.`);
                    resolve();
                } else {
                    // Ignore errors if the tool is already registered
                    if (stderr.includes('already exists')) {
                        logger.info(`MCP tool '${toolName}' is already registered.`);
                        resolve();
                    } else {
                        const errorMsg = `Failed to register MCP tool '${toolName}'. Exit code: ${code}. Stderr: ${stderr}`;
                        logger.error(errorMsg);
                        reject(new Error(errorMsg));
                    }
                }
            });

            addProcess.on('error', (err) => {
                logger.error(`Failed to start 'codex mcp add' for tool '${toolName}'.`, err);
                reject(err);
            });
        });
    }
}

async function setupCodexAuth() {
    const apiKey = process.env.OPENAI_API_KEY;
    
    if (!apiKey) {
        const errorMessage = 'OPENAI_API_KEY environment variable is not set!';
        logger.error(errorMessage);
        throw new Error(errorMessage);
    }
    
    // Ensure config directories exist, matching the environment for codex exec
    await ensureDirectory(path.join(WORKSPACE_ROOT, '.config'));
    await ensureDirectory(path.join(WORKSPACE_ROOT, '.local/share'));
    
    logger.info(`Attempting to log in to Codex via API key...`);

    return new Promise((resolve, reject) => {
        const loginProcess = spawn('codex', ['login', '--api-key', apiKey], {
            env: {
                ...process.env,
                HOME: WORKSPACE_ROOT,
                CODEX_HOME: path.join(WORKSPACE_ROOT, '.codex'),
                XDG_CONFIG_HOME: path.join(WORKSPACE_ROOT, '.config'),
                XDG_DATA_HOME: path.join(WORKSPACE_ROOT, '.local/share'),
            },
            stdio: 'pipe' // Capture stdio to prevent hanging and for debugging
        });

        let stdout = '';
        loginProcess.stdout.on('data', (data) => {
            stdout += data.toString();
        });
        
        let stderr = '';
        loginProcess.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        loginProcess.on('close', (code) => {
            logger.debug(`codex login stdout: ${stdout}`);
            logger.debug(`codex login stderr: ${stderr}`);

            if (code === 0) {
                logger.info('`codex login` command completed successfully.');
                resolve();
            } else {
                const errorMsg = `Codex login failed with exit code ${code}. Stderr: ${stderr}`;
                logger.error(errorMsg);
                reject(new Error(errorMsg));
            }
        });

        loginProcess.on('error', (err) => {
            logger.error('Failed to start `codex login` process.', err);
            reject(err);
        });
    });
}

async function prepareWorkingDirectory(projectPath = null) {
    let workDir;
    
    if (projectPath) {
        workDir = path.join(WORKSPACE_ROOT, 'projects', projectPath);
        await ensureDirectory(workDir);
    } else {
        // Create temporary directory for one-off tasks
        const tempId = uuidv4().substring(0, 8);
        workDir = path.join(WORKSPACE_ROOT, 'temp', tempId);
        await ensureDirectory(workDir);
    }
    
    // Initialize git if not exists
    const gitDir = path.join(workDir, '.git');
    try {
        await fs.access(gitDir);
    } catch {
        // Git directory doesn't exist, initialize it
        try {
            await new Promise((resolve, reject) => {
                const git = spawn('git', ['init'], { cwd: workDir });
                git.on('close', (code) => {
                    if (code === 0) {
                        logger.info(`Initialized git repository in ${workDir}`);
                        resolve();
                    } else {
                        reject(new Error(`Git init failed with code ${code}`));
                    }
                });
                git.on('error', reject);
            });
        } catch (error) {
            logger.warn(`Failed to initialize git repository: ${error.message}`);
        }
    }
    
    return workDir;
}

async function sendStreamEvent(taskId, eventType, data = {}) {
    if (taskStreams.has(taskId)) {
        const event = new StreamEvent(eventType, taskId, data);
        const stream = taskStreams.get(taskId);
        
        try {
            stream.write(event.toSSE());
        } catch (error) {
            logger.error(`Failed to send stream event for task ${taskId}:`, error);
        }
    }
}

async function executeCodexCommand(taskId, prompt, workingDir, options = {}) {
    const { 
        model, 
        images, 
        additionalArgs = [],
        sandbox = 'workspace-write',
        outputSchema,
        includePlanTool = false,
        fullAuto = false,
        dangerouslyBypass = false
    } = options;
    
    // Build command
    const cmd = ['codex', 'exec'];
    
    // Skip git repo check for containerized environment
    cmd.push('--skip-git-repo-check');
    
    // Set working directory
    cmd.push('--cd', workingDir);
    
    // Model selection
    if (model) {
        cmd.push('--model', model);
    }
    
    // Sandbox mode (default to workspace-write for safety)
    if (sandbox) {
        cmd.push('--sandbox', sandbox);
    }
    
    // Images support
    if (images && Array.isArray(images)) {
        images.forEach(image => {
            cmd.push('--image', image);
        });
    }
    
    // Output schema for structured responses
    if (outputSchema) {
        cmd.push('--output-schema', outputSchema);
    }
    
    // Include plan tool for better task breakdown
    if (includePlanTool) {
        cmd.push('--include-plan-tool');
    }
    
    // Automation modes
    if (fullAuto) {
        cmd.push('--full-auto');
    } else if (dangerouslyBypass) {
        cmd.push('--dangerously-bypass-approvals-and-sandbox');
    }
    
    // Add additional arguments
    if (Array.isArray(additionalArgs)) {
        cmd.push(...additionalArgs);
    }
    
    // Add prompt as last argument
    cmd.push(prompt);
    
    logger.info(`Executing command: ${cmd.join(' ')}`);
    
    // Send start event
    await sendStreamEvent(taskId, 'task_started', {
        command: cmd.join(' '),
        working_directory: workingDir
    });
    
    return new Promise((resolve, reject) => {
        const codexProcess = spawn('codex', cmd.slice(1), {
            cwd: workingDir,
            env: {
                ...process.env,
                OPENAI_API_KEY: process.env.OPENAI_API_KEY,  // Explicitly pass API key
                CODEX_UNSAFE_ALLOW_NO_SANDBOX: '1',
                HOME: '/workspace',  // Set HOME to writable directory
                XDG_CONFIG_HOME: '/workspace/.config',  // Set config dir to writable location
                XDG_DATA_HOME: '/workspace/.local/share',  // Set data dir to writable location
                CODEX_HOME: path.join(WORKSPACE_ROOT, '.codex')  // Point to our auth.json location
            }
        });
        
        let output = '';
        let errorOutput = '';
        
        codexProcess.stdout.on('data', async (data) => {
            const chunk = data.toString();
            output += chunk;
            
            // Send output events line by line
            const lines = chunk.split('\n').filter(line => line.trim());
            for (const line of lines) {
                await sendStreamEvent(taskId, 'output', { content: line });
            }
        });
        
        codexProcess.stderr.on('data', (data) => {
            errorOutput += data.toString();
        });
        
        codexProcess.on('close', async (code) => {
            if (code === 0) {
                await sendStreamEvent(taskId, 'task_completed', {
                    result: output,
                    working_directory: workingDir
                });
                resolve(output);
            } else {
                const errorMsg = `Command failed with exit code ${code}`;
                await sendStreamEvent(taskId, 'task_failed', {
                    error: errorMsg,
                    exit_code: code,
                    stderr: errorOutput
                });
                reject(new Error(`${errorMsg}: ${errorOutput}`));
            }
        });
        
        codexProcess.on('error', async (error) => {
            await sendStreamEvent(taskId, 'task_failed', {
                error: error.message
            });
            reject(error);
        });
    });
}

// JSON-RPC handlers
async function handleCodexCompletion(params) {
    const taskId = uuidv4();
    const { 
        prompt, 
        model, 
        images, 
        additional_args, 
        project_path,
        sandbox = 'workspace-write',
        output_schema,
        include_plan_tool = false,
        full_auto = false,
        dangerously_bypass = false
    } = params;
    
    const workingDir = await prepareWorkingDirectory(project_path);
    
    activeTasks.set(taskId, {
        method: 'codex_completion',
        params,
        working_dir: workingDir,
        started_at: new Date().toISOString()
    });
    
    try {
        const result = await executeCodexCommand(taskId, prompt, workingDir, {
            model,
            images,
            additionalArgs: additional_args,
            sandbox,
            outputSchema: output_schema,
            includePlanTool: include_plan_tool,
            fullAuto: full_auto,
            dangerouslyBypass: dangerously_bypass
        });
        
        return {
            task_id: taskId,
            output: result,
            working_directory: workingDir,
            timestamp: new Date().toISOString()
        };
    } finally {
        activeTasks.delete(taskId);
    }
}

async function handleWriteCode(params) {
    const { task, language, model, project_path } = params;
    const prompt = `Write ${language} code for the following task:\n\n${task}`;
    
    return handleCodexCompletion({
        prompt,
        model,
        project_path
    });
}

async function handleExplainCode(params) {
    const { code, model, project_path } = params;
    const prompt = `Please explain how this code works in detail:\n\n\`\`\`\n${code}\n\`\`\``;
    
    return handleCodexCompletion({
        prompt,
        model,
        project_path
    });
}

async function handleDebugCode(params) {
    const { code, issue_description, model, project_path } = params;
    let prompt;
    
    if (issue_description) {
        prompt = `Please find and fix the bug in this code. Issue description: ${issue_description}\n\nCode:\n\`\`\`\n${code}\n\`\`\``;
    } else {
        prompt = `Please find and fix any bugs in this code:\n\n\`\`\`\n${code}\n\`\`\``;
    }
    
    return handleCodexCompletion({
        prompt,
        model,
        project_path
    });
}

// HTTP request handlers
function parseBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
        });
        req.on('end', () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch (error) {
                reject(new Error('Invalid JSON'));
            }
        });
        req.on('error', reject);
    });
}

function sendJSON(res, data, statusCode = 200) {
    res.writeHead(statusCode, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    res.end(JSON.stringify(data, null, 2));
}

function sendSSE(res, taskId) {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Cache-Control'
    });
    
    // Store stream reference
    taskStreams.set(taskId, res);
    
    // Send initial connection event
    const connectEvent = new StreamEvent('stream_connected', taskId, {
        message: 'Connected to event stream'
    });
    res.write(connectEvent.toSSE());
    
    // Keep-alive ping every 30 seconds
    const pingInterval = setInterval(() => {
        if (taskStreams.has(taskId)) {
            const pingEvent = new StreamEvent('ping', taskId, { message: 'keepalive' });
            res.write(pingEvent.toSSE());
        }
    }, 30000);
    
    // Cleanup on client disconnect
    res.on('close', () => {
        clearInterval(pingInterval);
        taskStreams.delete(taskId);
        logger.info(`Stream closed for task: ${taskId}`);
    });
}

// Create HTTP server
const server = http.createServer(async (req, res) => {
    const parsedUrl = url.parse(req.url, true);
    const method = req.method;
    const pathname = parsedUrl.pathname;
    
    logger.info(`${method} ${pathname}`);
    
    try {
        // Handle CORS preflight
        if (method === 'OPTIONS') {
            res.writeHead(204, {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type, Authorization'
            });
            res.end();
            return;
        }
        
        // Health check endpoint (always public)
        if (method === 'GET' && pathname === '/health') {
            sendJSON(res, {
                status: 'healthy',
                timestamp: new Date().toISOString(),
                active_tasks: activeTasks.size,
                workspace_root: WORKSPACE_ROOT,
                version: '1.0.0'
            });
            return;
        }

        // Enforce authentication if AUTH_KEY is set
        if (AUTH_KEY) {
            const authHeader = req.headers['authorization'];
            const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.substring(7) : null;

            if (token !== AUTH_KEY) {
                logger.warn(`Unauthorized request from ${req.socket.remoteAddress}: missing or invalid token.`);
                sendJSON(res, { error: 'Unauthorized' }, 401);
                return;
            }
        }
        
        // Main JSON-RPC endpoint
        if (method === 'POST' && pathname === '/') {
            const body = await parseBody(req);
            const { jsonrpc = '2.0', method: rpcMethod, params, id } = body;
            
            let result;
            
            switch (rpcMethod) {
                case 'codex_completion':
                    result = await handleCodexCompletion(params);
                    break;
                case 'write_code':
                    result = await handleWriteCode(params);
                    break;
                case 'explain_code':
                    result = await handleExplainCode(params);
                    break;
                case 'debug_code':
                    result = await handleDebugCode(params);
                    break;
                default:
                    sendJSON(res, {
                        jsonrpc,
                        error: {
                            code: -32601,
                            message: 'Method not found',
                            data: { method: rpcMethod }
                        },
                        id
                    }, 400);
                    return;
            }
            
            sendJSON(res, {
                jsonrpc,
                result,
                id
            });
            return;
        }
        
        // SSE streaming endpoint
        if (method === 'GET' && pathname.startsWith('/stream/')) {
            const taskId = pathname.split('/')[2];
            if (taskId) {
                sendSSE(res, taskId);
                return;
            }
        }
        
        // Task management endpoints
        if (method === 'GET' && pathname === '/tasks') {
            const tasks = Array.from(activeTasks.entries()).map(([id, task]) => ({
                task_id: id,
                ...task
            }));
            
            sendJSON(res, {
                active_tasks: Array.from(activeTasks.keys()),
                count: activeTasks.size,
                tasks
            });
            return;
        }
        
        if (method === 'GET' && pathname.startsWith('/tasks/')) {
            const taskId = pathname.split('/')[2];
            if (taskId && activeTasks.has(taskId)) {
                sendJSON(res, {
                    task_id: taskId,
                    ...activeTasks.get(taskId)
                });
                return;
            } else {
                sendJSON(res, { error: 'Task not found' }, 404);
                return;
            }
        }
        
        // 404 for unknown endpoints
        sendJSON(res, { error: 'Not found' }, 404);
        
    } catch (error) {
        logger.error('Request error:', error);
        sendJSON(res, {
            error: 'Internal server error',
            message: error.message
        }, 500);
    }
});

// Start server
async function startServer() {
    try {
        await setupWorkspace();
        
        server.listen(PORT, '0.0.0.0', () => {
            logger.info('🚀 Codex HTTP Server started successfully!');
            logger.info(`📡 Server running on: http://0.0.0.0:${PORT}`);
            logger.info(`🏠 Workspace root: ${WORKSPACE_ROOT}`);
            logger.info(`📊 Health check: http://0.0.0.0:${PORT}/health`);
            logger.info(`🔗 JSON-RPC endpoint: http://0.0.0.0:${PORT}/`);
            logger.info(`📡 SSE streaming: http://0.0.0.0:${PORT}/stream/{taskId}`);
            logger.info(`🔧 Environment: ${process.env.NODE_ENV || 'development'}`);
            logger.info(`📝 Log level: ${LOG_LEVEL}`);
            logger.info('');
            logger.info('🤖 Available JSON-RPC methods:');
            logger.info('  - codex_completion: General Codex completion');
            logger.info('  - write_code: Generate code for specific tasks');
            logger.info('  - explain_code: Explain how code works');
            logger.info('  - debug_code: Find and fix bugs in code');
        });
        
    } catch (error) {
        logger.error('Failed to start server:', error);
        process.exit(1);
    }
}

// Graceful shutdown
process.on('SIGTERM', () => {
    logger.info('SIGTERM received, shutting down gracefully...');
    server.close(() => {
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    logger.info('SIGINT received, shutting down gracefully...');
    server.close(() => {
        process.exit(0);
    });
});

// Start the server
startServer();