/**
 * Replay smoke loop: A minimal OpenAI-chat client loop (no packages imported)
 * that replays the fixture through createPlayer in sequential mode and asserts
 * each assistant turn is valid JSON-shaped (tool calls parse, finish_reason present).
 *
 * Exported runReplay(cassette) -> {turns, toolCalls}.
 */

import { createPlayer } from './player.mjs';

export async function runReplay(cassette) {
  if (!cassette || typeof cassette !== 'object') {
    throw new Error('Invalid cassette: expected an object');
  }

  if (!Array.isArray(cassette.entries) || cassette.entries.length === 0) {
    throw new Error('Invalid cassette: missing entries');
  }

  const player = createPlayer(cassette, { mode: 'sequential' });
  const turns = [];
  const toolCalls = [];

  for (let i = 0; i < cassette.entries.length; i++) {
    const entry = cassette.entries[i];
    const request = entry.request;

    const playerRequest = {
      model: request.model,
      messages: request.messages || [],
      ...(request.tools ? { tools: request.tools } : {}),
      ...(request.tool_choice ? { tool_choice: request.tool_choice } : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    };

    let response;
    try {
      response = await player(playerRequest);
    } catch (err) {
      throw new Error(`Failed to replay entry ${i}: ${err.message}`);
    }

    if (!response || response.status !== 200) {
      throw new Error(`Invalid response for entry ${i}: status ${response ? response.status : 'unknown'}`);
    }

    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch (err) {
      throw new Error(`Invalid JSON response for entry ${i}: ${err.message}`);
    }

    if (!body || typeof body !== 'object') {
      throw new Error(`Invalid response body for entry ${i}: not an object`);
    }

    const choice = body.choices?.[0];
    if (!choice || typeof choice !== 'object') {
      throw new Error(`Invalid choice for entry ${i}: missing choices[0]`);
    }

    if (typeof choice.finish_reason !== 'string' || choice.finish_reason.length === 0) {
      throw new Error(`Invalid finish_reason for entry ${i}: missing or empty`);
    }

    const message = choice.message;
    if (!message || typeof message !== 'object') {
      throw new Error(`Invalid message for entry ${i}: missing message`);
    }

    const calls = message.tool_calls;
    if (calls !== undefined) {
      if (!Array.isArray(calls)) {
        throw new Error(`Invalid tool_calls for entry ${i}: not an array`);
      }
      for (let j = 0; j < calls.length; j++) {
        const call = calls[j];
        if (!call || typeof call !== 'object') {
          throw new Error(`Invalid tool call ${j} for entry ${i}`);
        }
        if (call.type !== 'function') {
          throw new Error(`Invalid tool call ${j} type for entry ${i}: expected function`);
        }
        if (!call.function || typeof call.function !== 'object') {
          throw new Error(`Invalid tool call ${j} function for entry ${i}`);
        }
        if (typeof call.function.name !== 'string' || call.function.name.length === 0) {
          throw new Error(`Invalid tool call ${j} name for entry ${i}`);
        }
        if (typeof call.function.arguments !== 'string') {
          throw new Error(`Invalid tool call ${j} arguments for entry ${i}: not a string`);
        }
        try {
          JSON.parse(call.function.arguments);
        } catch (err) {
          throw new Error(`Invalid tool call ${j} arguments for entry ${i}: not valid JSON`);
        }
        toolCalls.push({
          entryIndex: i,
          callIndex: j,
          name: call.function.name,
          arguments: call.function.arguments,
        });
      }
    }

    turns.push({
      index: i,
      finish_reason: choice.finish_reason,
      hasToolCalls: Array.isArray(calls) && calls.length > 0,
      toolCallCount: Array.isArray(calls) ? calls.length : 0,
    });
  }

  return { turns, toolCalls };
}
