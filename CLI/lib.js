#!/usr/bin/env node
/*
FILE: CLI/lib.js
Version: 2.1.0
Purpose: Library for simulation scripts

Public Methods:
- constructor(serverUrl)              Create new CLI client instance
- login(username, password, options)  Authenticate and create/update context
- logout(contextName)                 Remove token from context (keeps credentials)
- switch(contextName)                 Change active context
- deleteContext(contextName)          Permanently remove a context
- listContexts()                      Return array of all contexts with status
- getActiveContext()                  Return current active context info
- exec(command)                       Execute command in active context (with auto-renew)
- execPublic(command)                 Execute public command (no authentication)
- execAs(contextName, command)        Execute command in specific context (NO context switch)
- execJson(command)                   Execute and return only data (throws on error)
- ensureUser(username, password, opts) Login or auto-register user, returns context
- waitForBallotState(ballotId, state, timeoutMs, intervalMs)
- waitForCondition(checkFn, timeoutMs, intervalMs)
- health()                            Check server health
- cleanup()                           Clear database (requires system user auth)
- redeemInvitation(token, alias)      Create guest account from invitation
- reset()                             Clear all local contexts (state files)

Context Storage:
- Contexts saved under ./CLI/state/contexts/<safe-server-name>-<url-hash>/<name>.json
- Active context stored per server
- Each context contains: token, identity, expiresAt, credentials

Auto-renewal:
- _ensureAuthenticatedForContext() checks token expiry for any context
- If token expired and credentials exist, automatically re-login
- exec() reloads contexts from disk before each command to ensure fresh data

Changes in v2.1.0:
- Fixed execAs() to NOT switch active context (was causing context corruption)
- Added _ensureAuthenticatedForContext() for context-specific token renewal
- exec() now reloads contexts from disk before execution
- Fixed context persistence issues that caused role changes to fail in simulations
*/

const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const httpError = require('./httpError');
const config = require('./config');

class Simulator {
  // Service clients need HTTP commands without loading or saving user contexts.
  static createStateless(serverUrl = config.serverUrl) {
    const client = Object.create(Simulator.prototype);
    client.serverUrl = Simulator._normalizeServerUrl(serverUrl);
    return client;
  }

  constructor(serverUrl = config.serverUrl) {
    this.serverUrl = Simulator._normalizeServerUrl(serverUrl);
    this.stateDir = path.join(__dirname, 'state');
    this.contextsRootDir = path.join(this.stateDir, 'contexts');
    this.serverContextDirName = Simulator._serverContextDirName(this.serverUrl);
    this.contextsDir = path.join(this.contextsRootDir, this.serverContextDirName);
    this.activeFile = path.join(this.contextsDir, 'active.txt');
    this.legacyContextsDir = this.contextsRootDir;
    this.legacyActiveFile = path.join(this.stateDir, 'active.txt');
    
    // Create directories if they don't exist
    fs.mkdirSync(this.contextsDir, { recursive: true });
    this._migrateLegacyContexts();
    
    // Load active context
    this.activeContext = this._loadActiveContext();
    this.contexts = this._loadAllContexts();
  }

  static _normalizeServerUrl(serverUrl) {
    const parsed = new URL(serverUrl);
    return parsed.toString().replace(/\/$/, '');
  }

  static _serverContextDirName(serverUrl) {
    const crypto = require('crypto');
    const safeName = serverUrl.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'server';
    const hash = crypto.createHash('sha256').update(serverUrl).digest('hex').slice(0, 10);
    return `${safeName}-${hash}`;
  }

  getInstanceContextDir() {
    return path.join(__dirname, 'contexts', this.serverContextDirName);
  }

  _migrateLegacyContexts() {
    // Context files created before server-scoped storage belong to localhost.
    if (this.serverUrl !== 'http://localhost:3000') return;
    try {
      fs.mkdirSync(this.contextsDir, { recursive: true });
      for (const file of fs.readdirSync(this.legacyContextsDir, { withFileTypes: true })) {
        if (!file.isFile() || !file.name.endsWith('.json')) continue;
        const source = path.join(this.legacyContextsDir, file.name);
        const destination = path.join(this.contextsDir, file.name);
        if (!fs.existsSync(destination)) fs.renameSync(source, destination);
      }
      const legacyActive = this._readActiveFile(this.legacyActiveFile);
      if (legacyActive && !fs.existsSync(this.activeFile)) {
        fs.writeFileSync(this.activeFile, legacyActive);
      }
    } catch (error) {
      throw new Error(`Could not migrate legacy local CLI contexts: ${error.message}`);
    }
  }

  // ========== PRIVATE METHODS ==========

  _loadActiveContext() {
    return this._readActiveFile(this.activeFile);
  }

  _readActiveFile(file) {
    try {
      if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
    } catch (e) {}
    return null;
  }

  _saveActiveContext(name) {
    if (name) {
      fs.writeFileSync(this.activeFile, name);
    } else if (fs.existsSync(this.activeFile)) {
      fs.unlinkSync(this.activeFile);
    }
    this.activeContext = name;
  }

  _loadAllContexts() {
    const contexts = {};
    try {
      const files = fs.readdirSync(this.contextsDir);
      for (const file of files) {
        if (file.endsWith('.json')) {
          const name = file.replace('.json', '');
          const data = fs.readFileSync(path.join(this.contextsDir, file), 'utf8');
          contexts[name] = JSON.parse(data);
        }
      }
    } catch (e) {}
    return contexts;
  }

  _saveContext(name, data) {
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) throw new Error('Context name contains invalid characters.');
    const file = path.join(this.contextsDir, `${name}.json`);
    const scopedData = { ...data, serverUrl: this.serverUrl };
    fs.writeFileSync(file, JSON.stringify(scopedData, null, 2));
    this.contexts[name] = scopedData;
  }

  _deleteContext(name) {
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) throw new Error('Context name contains invalid characters.');
    const file = path.join(this.contextsDir, `${name}.json`);
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
    delete this.contexts[name];
    if (this.activeContext === name) {
      this._saveActiveContext(null);
    }
  }

  async _httpRequest(method, endpoint, body = null, token = null) {
    const publicRequests = new Set([
      'GET /health',
      'POST /api/auth/login',
      'POST /api/auth/register',
      'POST /api/auth/redeem'
    ]);
    const pathname = endpoint.split('?')[0];
    if (!publicRequests.has(`${method.toUpperCase()} ${pathname}`)) {
      throw new Error(`Direct REST request is not allowed in simulations: ${method} ${pathname}. Use a CLI command instead.`);
    }

    const url = `${this.serverUrl}${endpoint}`;
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const options = { method, headers };
    if (body) options.body = JSON.stringify(body);

    const response = await fetch(url, options);
    const data = await response.json();

    if (!response.ok) {
      throw httpError(response, data);
    }
    return data;
  }

  async _execRemote(command, token) {
    const url = `${this.serverUrl}/cli/execute`;
    const headers = { 'Content-Type': 'application/json' };
    
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    
    const response = await fetch(url, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({ command })
    });
    
    const data = await response.json();
    
    if (!response.ok) {
      throw httpError(response, data);
    }
    
    return data;
  }

  _isTokenExpired(expiresAt) {
    if (!expiresAt) return true;
    return Date.now() >= new Date(expiresAt).getTime() - 60000;
  }

  /**
   * Ensure a specific context has a valid token
   * Does NOT change the active context
   * Auto-renews if token expired
   */
  async _ensureAuthenticatedForContext(contextName) {
    // Reload context from disk to ensure fresh data
    this.contexts = this._loadAllContexts();
    
    const context = this.contexts[contextName];
    if (!context) {
      throw new Error(`Context "${contextName}" not found. Run login first.`);
    }

    if (context.token && !this._isTokenExpired(context.expiresAt)) {
      return context.token;
    }

    if (!context.credentials) {
      throw new Error(`Context "${contextName}" has no credentials and token expired. Cannot auto-renew.`);
    }

    console.log(`🔄 Token expired for "${contextName}", re-logging in...`);
    
    const loginResult = await this._httpRequest('POST', '/api/auth/login', {
      type: 'user',
      credentials: {
        email: context.credentials.username,
        password: context.credentials.password,
        ...(context.credentials.tenantId && { tenantId: context.credentials.tenantId })
      }
    });

    const newToken = loginResult.access_token;
    const newIdentity = loginResult.identity;
    const expiresAt = new Date(Date.now() + (loginResult.expires_in * 1000)).toISOString();

    const updatedContext = {
      ...context,
      token: newToken,
      identity: newIdentity,
      expiresAt
    };

    this._saveContext(contextName, updatedContext);

    return newToken;
  }

  // ========== PUBLIC METHODS ==========

  /**
   * Login and create/update a context
   * @param {string} username - Email or userId
   * @param {string} password - Password
   * @param {Object} options - { context, tenantId, alias }
   */
  async login(username, password, options = {}) {
    const contextName = options.context || username.split('@')[0];
    const tenantId = options.tenantId || null;

    const loginBody = {
      type: 'user',
      credentials: {
        email: username,
        password: password,
        ...(tenantId && { tenantId })
      }
    };

    const result = await this._httpRequest('POST', '/api/auth/login', loginBody);

    const expiresAt = new Date(Date.now() + (result.expires_in * 1000)).toISOString();

    this._saveContext(contextName, {
      token: result.access_token,
      identity: result.identity,
      expiresAt,
      credentials: {
        username,
        password,
        ...(tenantId && { tenantId })
      },
      createdAt: new Date().toISOString()
    });

    if (!this.activeContext) {
      this._saveActiveContext(contextName);
    }

    return {
      success: true,
      context: contextName,
      identity: result.identity,
      expiresAt
    };
  }

  /**
   * Switch to active context
   */
  switch(contextName) {
    if (!this.contexts[contextName]) {
      throw new Error(`Context "${contextName}" not found`);
    }
    this._saveActiveContext(contextName);
    return { success: true, context: contextName };
  }

  /**
   * Logout from active context (removes token but keeps credentials)
   */
  async logout(contextName = null) {
    const name = contextName || this.activeContext;
    if (!name || !this.contexts[name]) {
      throw new Error(`Context "${name}" not found`);
    }

    this._saveContext(name, {
      ...this.contexts[name],
      token: null,
      identity: null,
      expiresAt: null
    });

    if (this.activeContext === name) {
      this._saveActiveContext(null);
    }

    return { success: true, context: name, loggedOut: true };
  }

  /**
   * Delete a context completely
   */
  deleteContext(contextName) {
    this._deleteContext(contextName);
    return { success: true, context: contextName, deleted: true };
  }

  /**
   * List all contexts
   */
  listContexts() {
    const result = [];
    for (const [name, data] of Object.entries(this.contexts)) {
      result.push({
        name,
        active: this.activeContext === name,
        authenticated: !!data.token && !this._isTokenExpired(data.expiresAt),
        identity: data.identity?.id || data.identity?.email || null,
        expiresAt: data.expiresAt
      });
    }
    return result;
  }

  /**
   * Get active context
   */
  getActiveContext() {
    if (!this.activeContext) return null;
    const context = this.contexts[this.activeContext];
    if (!context) return null;
    return {
      name: this.activeContext,
      authenticated: !!context.token && !this._isTokenExpired(context.expiresAt),
      identity: context.identity,
      expiresAt: context.expiresAt
    };
  }
  
  /**
   * Ensures a user exists and returns authenticated context
   * If user doesn't exist, registers them first
   * @param {string} username - Email address
   * @param {string} password - Password
   * @param {Object} options - { context, alias, tenantId }
   * @returns {Promise<Object>} Login result
   */
  async ensureUser(username, password, options = {}) {
    const alias = options.alias || username.split('@')[0];
    
    try {
      const loginResult = await this.login(username, password, options);
      return loginResult;
    } catch (error) {
      if (error.message.includes('User not found') || 
          error.message.includes('Invalid credentials')) {
        
        console.log(`📝 User ${username} not found, registering...`);
        
        const registerResult = await this._httpRequest('POST', '/api/auth/register', {
          username: alias.toLowerCase(),
          alias: alias,
          email: username,
          password: password,
          confirmPassword: password
        }, null);
        
        if (!registerResult.success) {
          throw new Error(`Registration failed: ${registerResult.error}`);
        }
        
        return await this.login(username, password, options);
      }
      throw error;
    }
  }

  /**
   * Execute command in active context
   * Reloads contexts from disk to ensure fresh data
   */
  async exec(command) {
    if (!this.activeContext) {
      throw new Error('No active context. Run login() or switch() first.');
    }

    // Reload contexts from disk to ensure fresh data
    this.contexts = this._loadAllContexts();
    this.activeContext = this._loadActiveContext();

    if (!this.activeContext || !this.contexts[this.activeContext]) {
      throw new Error('Active context not found. Run login() or switch() first.');
    }

    const token = await this._ensureAuthenticatedForContext(this.activeContext);
    const result = await this._execRemote(command, token);
    return result;
  }

  /**
   * Execute public command (no authentication)
   * Useful for: invitations redeem, health, cleanup, etc.
   */
  async execPublic(command) {
    const result = await this._execRemote(command, null);
    return result;
  }

  /**
   * Execute command in a specific context (temporary, DOES NOT change active context)
   * This is the FIXED version - no context switching, uses direct token access
   */
  async execAs(contextName, command) {
    // Reload contexts from disk to ensure fresh data
    this.contexts = this._loadAllContexts();
    
    const context = this.contexts[contextName];
    if (!context) {
      throw new Error(`Context "${contextName}" not found`);
    }

    // Get token for this specific context (with auto-renew)
    const token = await this._ensureAuthenticatedForContext(contextName);
    
    // Execute command with that token
    return await this._execRemote(command, token);
  }

  /**
   * Execute command and return only data (assumes success)
   */
  async execJson(command) {
    const result = await this.exec(command);
    if (!result.success) {
      throw new Error(result.error || 'Command failed');
    }
    return result.data;
  }

  /**
   * Wait for a ballot to reach a specific state
   */
  async waitForBallotState(ballotId, targetState, timeoutMs = 30000, intervalMs = 1000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const result = await this.exec(`ballots select --id=${ballotId}`);
        if (result.success && result.data) {
          const currentState = result.data.state || (result.data.closed ? 'closed' : 'ready');
          if (currentState === targetState) {
            return { success: true, state: currentState, elapsed: Date.now() - start };
          }
        }
      } catch (e) {
        // Ignore errors and keep waiting
      }
      await new Promise(r => setTimeout(r, intervalMs));
    }
    throw new Error(`Timeout waiting for ballot ${ballotId} to reach state ${targetState}`);
  }

  /**
   * Wait for a generic condition
   */
  async waitForCondition(checkFn, timeoutMs = 30000, intervalMs = 1000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const result = await checkFn();
      if (result) return true;
      await new Promise(r => setTimeout(r, intervalMs));
    }
    throw new Error(`Timeout waiting for condition`);
  }

  /**
   * Server health check
   */
  async health() {
    try {
      const result = await this._httpRequest('GET', '/health', null, null);
      return { success: true, status: result };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
  
  /**
   * Reset all local contexts (clear cached credentials)
   */
  reset() {
    this._clearAllContexts();
    this.activeContext = null;
    this.contexts = {};
    console.log('🔄 Local contexts reset');
  }
  
  _clearAllContexts() {
    try {
      if (fs.existsSync(this.contextsDir)) {
        const files = fs.readdirSync(this.contextsDir);
        for (const file of files) {
          if (file.endsWith('.json') || file === 'active.txt') {
            fs.unlinkSync(path.join(this.contextsDir, file));
          }
        }
      }
      console.log('🧹 Local contexts cleared');
    } catch (error) {
      console.log('⚠️ Could not clear local contexts:', error.message);
    }
  }

  /**
   * Cleanup database (development only)
   */
  async cleanup() {
    try {
      if (!this.activeContext) {
        throw new Error('No active context. Login first before cleanup.');
      }
      
      return await this.exec('admin cleanup');
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
  
  /**
   * Redeem invitation (public-specific endpoint)
   */
  async redeemInvitation(token, alias) {
    const url = `${this.serverUrl}/api/auth/redeem`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ invitationToken: token, alias })
    });
    
    const data = await response.json();
    
    console.log('🔍 Redeem response FULL:', JSON.stringify(data, null, 2));
    
    if (!response.ok) {
      throw new Error(data.error || `HTTP ${response.status}`);
    }
    
    return {
      userId: data.credentials?.userId,
      username: data.credentials?.username,
      password: data.credentials?.password,
      expiresAt: data.credentials?.expiresAt,
      spaceId: data.space?.id
    };
  }

	/**
	 * Run a sequence bot with API key authentication
	 * @param {string} seqId - Sequence ID
	 * @param {number} delayMs - Delay between turns in ms
	 * @param {Object} botCredentials - API key credentials { apiKeyId, secret }
	 * @returns {Promise<Object>} Bot result
	 */
	async runSeqBot(seqId, delayMs = 2000, botCredentials = null) {
			console.log(`🤖 Starting sequence bot for ${seqId}`);
			console.log(`   Delay: ${delayMs}ms`);

			// ============================================================
			// 1. AUTHENTICATE WITH BOT CREDENTIALS
			// ============================================================
			let token = null;
			let botIdentity = null;

			if (botCredentials) {
					// Login with API key
					const loginResult = await this._httpRequest('POST', '/api/auth/login', {
							type: 'user',
							credentials: {
									email: botCredentials.apiKeyId,
									password: botCredentials.secret
							}
					});

					if (!loginResult.access_token) {
							throw new Error('Failed to authenticate bot');
					}

					token = loginResult.access_token;
					botIdentity = loginResult.identity;
					console.log(`✅ Bot authenticated as: ${botIdentity.id}`);
			} else {
					// Fallback: use active context
					if (!this.activeContext) {
							throw new Error('No active context and no bot credentials provided');
					}
					const context = this.contexts[this.activeContext];
					if (!context || !context.token) {
							throw new Error('No valid token in active context');
					}
					token = context.token;
					botIdentity = context.identity;
					console.log(`✅ Using active context: ${botIdentity.id}`);
			}
			// ============================================================

			let running = true;
			let turnCount = 0;

			try {
					while (running) {
							// ============================================================
							// 2. GET SEQUENCE STATE
							// ============================================================
							const sequenceResult = await this._execRemote(`seqs get --id=${seqId}`, token);
							if (!sequenceResult.success || !sequenceResult.data) {
									console.log(`⚠️ Failed to get sequence: ${sequenceResult.error}`);
									await this._wait(delayMs);
									continue;
							}

							const sequence = sequenceResult.data;
							console.log(`\n📊 Turn ${sequence.currentTurn + 1} - State: ${sequence.state}`);

							// Check terminal states
							if (sequence.state === 'finished' || sequence.state === 'deleted') {
									console.log(`🏁 Sequence ${sequence.state}`);
									running = false;
									break;
							}

							if (sequence.state === 'paused') {
									console.log(`⏸️ Sequence paused, waiting...`);
									await this._wait(delayMs);
									continue;
							}

							// ============================================================
							// 3. GET ACTIVE BALLOT
							// ============================================================
							const activeBallotId = sequence.ballotIds && sequence.ballotIds.length > 0
									? sequence.ballotIds[sequence.ballotIds.length - 1]
									: null;

							if (activeBallotId) {
									const ballotResult = await this._execRemote(`ballots select --id=${activeBallotId}`, token);
									if (ballotResult.success && ballotResult.data) {
											const ballot = ballotResult.data;

											// Check if ballot is closed
											if (ballot.closed || ballot.state === 'closed') {
													// ============================================================
													// 4. PROCESS RESULT
													// ============================================================
													const resultsResult = await this._execRemote(`ballots results --id=${activeBallotId}`, token);
													if (resultsResult.success && resultsResult.data) {
															const results = resultsResult.data;
															const winner = results.finalResult?.winningOption;

															const historyEntry = {
																	turn: sequence.currentTurn + 1,
																	ballotId: activeBallotId,
																	winner: winner?.text || winner?.date || 'Unknown',
																	votes: results.ballotSummary?.totalVotes || 0
															};

															console.log(`🎯 Turn ${historyEntry.turn} - Winner: "${historyEntry.winner}"`);
															console.log(`   Votes: ${historyEntry.votes}`);

															// Update sequence
															const turnHistory = [...(sequence.turnHistory || []), historyEntry];

															await this._execRemote(
																	`seqs state --id=${seqId} --state='${sequence.state}' --turn=${sequence.currentTurn + 1} --ballots='${JSON.stringify(sequence.ballotIds)}' --history='${JSON.stringify(turnHistory)}'`,
																	token
															);

															turnCount++;

															// ============================================================
															// 5. GENERATE NEXT TURN (RANDOM TEXT OPTIONS)
															// ============================================================
															const nextTurn = sequence.currentTurn + 1;
															const count = Math.floor(Math.random() * 4) + 2; // 2-5 options
															const options = [];
															const subjects = ['Go to', 'Choose', 'Select', 'Pick', 'Vote for'];
															const objects = ['forest', 'mountain', 'village', 'castle', 'river', 'bridge', 'tower', 'cave'];

															for (let i = 0; i < count; i++) {
																	const subject = subjects[Math.floor(Math.random() * subjects.length)];
																	const object = objects[Math.floor(Math.random() * objects.length)];
																	options.push({
																			type: 'text',
																			text: `${subject} ${object}`
																	});
															}

															const optionsJson = JSON.stringify(options);
															const createResult = await this._execRemote(
																	`ballots create --title="Turn ${nextTurn}" --space=${sequence.spaceId} --options='${optionsJson}' --state=ready --seq=${seqId}`,
																	token
															);

															if (createResult.success) {
																	console.log(`✅ Created ballot for turn ${nextTurn} with ${options.length} options`);
															} else {
																	console.log(`❌ Failed to create ballot: ${createResult.error}`);
																	await this._execRemote(
																			`seqs state --id=${seqId} --state='finished'`,
																			token
																	);
																	running = false;
																	break;
															}
															// ============================================================
													}
											} else if (ballot.state === 'awaiting') {
													console.log(`⏳ Activating awaiting ballot...`);
													await this._execRemote(
															`ballots state --id=${activeBallotId} --state=ready`,
															token
													);
													console.log(`✅ Ballot activated`);
											} else {
													console.log(`⏳ Waiting for votes... (${ballot.state})`);
											}
									}
							} else {
									// ============================================================
									// 6. NO ACTIVE BALLOT - Create first one
									// ============================================================
									console.log(`📝 Creating first ballot...`);
									const count = Math.floor(Math.random() * 4) + 2;
									const options = [];
									const subjects = ['Go to', 'Choose', 'Select', 'Pick', 'Vote for'];
									const objects = ['forest', 'mountain', 'village', 'castle', 'river', 'bridge', 'tower', 'cave'];

									for (let i = 0; i < count; i++) {
											const subject = subjects[Math.floor(Math.random() * subjects.length)];
											const object = objects[Math.floor(Math.random() * objects.length)];
											options.push({
													type: 'text',
													text: `${subject} ${object}`
											});
									}

									const optionsJson = JSON.stringify(options);
									const createResult = await this._execRemote(
											`ballots create --title="Turn 1" --space=${sequence.spaceId} --options='${optionsJson}' --state=ready --seq=${seqId}`,
											token
									);

									if (createResult.success) {
											console.log(`✅ Created first ballot with ${options.length} options`);
									} else {
											console.log(`❌ Failed to create ballot: ${createResult.error}`);
											running = false;
											break;
									}
									// ============================================================
							}

							await this._wait(delayMs);
					}

					console.log(`\n🤖 Bot stopped after ${turnCount} turns`);
					return { success: true, turns: turnCount };

			} catch (error) {
					console.error(`❌ Bot error: ${error.message}`);
					return { success: false, error: error.message, turns: turnCount };
			}
	}

	/**
	 * Helper: Wait for specified milliseconds
	 * @param {number} ms - Milliseconds to wait
	 * @returns {Promise<void>}
	 */
	_wait(ms) {
			return new Promise(resolve => setTimeout(resolve, ms));
	}
	
	
}

module.exports = Simulator;
