# Runs inside the Chatwoot rails container via `rails runner`.
require 'securerandom'
pw = "Osas-E2e-#{SecureRandom.hex(6)}-A1!"
account = Account.create!(name: 'OSAS E2E')
user = User.new(name: 'E2E Admin', email: 'e2e-admin@example.com', password: pw, password_confirmation: pw)
user.skip_confirmation! if user.respond_to?(:skip_confirmation!)
user.save!
AccountUser.create!(account_id: account.id, user_id: user.id, role: :administrator)
channel = Channel::Api.create!(account: account)
inbox = Inbox.create!(account: account, name: 'E2E API', channel: channel)
puts "SEED_ACCOUNT_ID=#{account.id}"
puts "SEED_INBOX_ID=#{inbox.id}"
puts "SEED_TOKEN=#{user.access_token.token}"
