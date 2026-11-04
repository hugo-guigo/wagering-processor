#!/bin/sh
# Cria as filas do desafio quando o MiniStack fica pronto.
# A DLQ vem primeiro porque a fila principal aponta para ela na redrive policy.
set -e

awslocal sqs create-queue --queue-name wager-transactions-dlq.fifo \
  --attributes FifoQueue=true,MessageRetentionPeriod=1209600

DLQ_ARN=$(awslocal sqs get-queue-attributes \
  --queue-url "$(awslocal sqs get-queue-url --queue-name wager-transactions-dlq.fifo --query QueueUrl --output text)" \
  --attribute-names QueueArn --query Attributes.QueueArn --output text)

# maxReceiveCount=5: depois da 5ª entrega sem ack, a mensagem vai para a DLQ.
# Deduplicação explícita (MessageDeduplicationId = messageId), não por conteúdo.
cat > /tmp/atributos.json <<JSON
{
  "FifoQueue": "true",
  "ContentBasedDeduplication": "false",
  "VisibilityTimeout": "30",
  "RedrivePolicy": "{\"deadLetterTargetArn\":\"$DLQ_ARN\",\"maxReceiveCount\":\"5\"}"
}
JSON
awslocal sqs create-queue --queue-name wager-transactions.fifo --attributes file:///tmp/atributos.json
echo "filas criadas"
