-- VOICE-PRO-04: the assistant's model (REG.RU AI, OpenAI-compatible) is its own kind, apart from the voice,
-- so a salon can think with one provider and speak with another (SaluteSpeech).
ALTER TABLE tenant_integrations DROP CONSTRAINT IF EXISTS tenant_integrations_kind_check;
ALTER TABLE tenant_integrations ADD CONSTRAINT tenant_integrations_kind_check CHECK (kind IN ('telegram', 'sms', 'fiscal', 'acquiring', 'telephony', 'voice', 'assistant'));
UPDATE tenant_integrations SET kind = 'assistant' WHERE provider IN ('reg_ai', 'openai_voice');
