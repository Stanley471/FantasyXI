-- Cursor-paginated, filtered transaction history (issue #496).
CREATE INDEX "transactions_user_id_created_at_idx" ON "transactions"("user_id", "created_at");
CREATE INDEX "transactions_user_id_status_idx" ON "transactions"("user_id", "status");
CREATE INDEX "transactions_user_id_type_idx" ON "transactions"("user_id", "type");
