#!/usr/bin/env node
/*
FILE: CLI/cli.js
Purpose: CLI for executing standalone commands using the library
Usage: 
  node CLI/cli.js login --username=alice --password=alice123
  node CLI/cli.js exec "spaces list"
  node CLI/cli.js switch bob
  node CLI/cli.js list
  node CLI/cli.js status
*/

const Simulator = require('./lib');

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log(`
Simulator CLI - Commands:

  login --username=<email> --password=<pwd> [--context=<name>]
  logout [--context=<name>]
  switch --context=<name>
  delete --context=<name>
  list
  status
  exec "<command>"
  exec-as --context=<name> "<command>"
  health
  cleanup
	seq-bot --id=<gameId> [--delay=<ms>]
`);
    return;
  }

  const sim = new Simulator();
  
  // Simple argument parsing
  const command = args[0];
  const options = {};

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      // Check if next argument is the value (doesn't start with --)
      if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
        options[key] = args[i + 1];
        i++; // Skip the value
      } else {
        options[key] = true;
      }
    } else if (command === 'exec' && i === 1) {
      options.command = arg;
    } else if (command === 'exec-as' && i === 2) {
      options.command = arg;
    }
  }

  try {
    switch (command) {
      case 'login':
        if (!options.username || !options.password) {
          throw new Error('--username and --password required');
        }
        const result = await sim.login(options.username, options.password, {
          context: options.context,
          tenantId: options.tenant
        });
        console.log(`✅ Logged in as ${result.identity.id} (context: ${result.context})`);
        break;

      case 'logout':
        const logoutResult = await sim.logout(options.context);
        console.log(`✅ Logged out from ${logoutResult.context}`);
        break;

      case 'switch':
        if (!options.context) throw new Error('--context required');
        await sim.switch(options.context);
        console.log(`✅ Switched to context: ${options.context}`);
        break;

      case 'delete':
        if (!options.context) throw new Error('--context required');
        await sim.deleteContext(options.context);
        console.log(`✅ Deleted context: ${options.context}`);
        break;

      case 'list':
        const contexts = sim.listContexts();
        console.log('\n📋 Contexts:');
        for (const ctx of contexts) {
          const activeMark = ctx.active ? '★' : ' ';
          const authMark = ctx.authenticated ? '🔐' : '🔓';
          console.log(`  ${activeMark} ${authMark} ${ctx.name} - ${ctx.identity || 'no identity'}`);
        }
        console.log('');
        break;

      case 'status':
        const active = sim.getActiveContext();
        if (!active) {
          console.log('❌ No active context');
        } else {
          console.log(`\n✅ Active context: ${active.name}`);
          console.log(`   Authenticated: ${active.authenticated ? 'Yes' : 'No'}`);
          console.log(`   Identity: ${active.identity?.id || active.identity?.email}`);
          console.log(`   Expires: ${active.expiresAt || 'N/A'}\n`);
        }
        break;

      case 'exec':
        if (!options.command) throw new Error('Command string required');
        const execResult = await sim.exec(options.command);
        console.log(JSON.stringify(execResult, null, 2));
        break;

      case 'exec-as':
        if (!options.context) throw new Error('--context required');
        if (!options.command) throw new Error('Command string required');
        const execAsResult = await sim.execAs(options.context, options.command);
        console.log(JSON.stringify(execAsResult, null, 2));
        break;

      case 'health':
        const health = await sim.health();
        console.log(JSON.stringify(health, null, 2));
        break;

      case 'cleanup':
        const cleanup = await sim.cleanup();
        console.log(JSON.stringify(cleanup, null, 2));
        break;
				
			case 'seq-bot':
				if (!options.id) throw new Error('--id required (sequence ID)');
				const delay = parseInt(options.delay) || 2000;
				const seqBotResult = await sim.runSeqBot(options.id, delay);
				console.log(JSON.stringify(seqBotResult, null, 2));
				break;
				

      default:
        console.log(`❌ Unknown command: ${command}`);
    }
  } catch (error) {
    console.error(`❌ Error: ${error.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = Simulator;
