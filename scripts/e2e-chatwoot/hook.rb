# Creates the account-level webhook. URL and secret come from the container env.
w = Webhook.create!(account_id: 1, name: 'osas-e2e', webhook_type: :account_type,
  url: ENV.fetch('E2E_HOOK_URL'), subscriptions: %w[message_created conversation_created],
  secret: ENV.fetch('E2E_HOOK_SECRET'))
puts "HOOK_ID=#{w.id} SECRET_MATCHES=#{w.reload.secret == ENV['E2E_HOOK_SECRET']}"
