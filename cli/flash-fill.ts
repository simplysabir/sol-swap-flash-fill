import { NATIVE_MINT } from "@solana/spl-token";
import {
  programAuthority,
  provider,
  wallet,
  program,
  connection,
  getAdressLookupTableAccounts,
  instructionDataToTransactionInstruction,
} from "./helper";
import { PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, SYSVAR_INSTRUCTIONS_PUBKEY } from "@solana/web3.js";
import fetch from "node-fetch";

const API_ENDPOINT = "https://quote-api.jup.ag/v6";

const getQuote = async (
  fromMint: PublicKey,
  toMint: PublicKey,
  amount: number
) => {
  return fetch(
    `${API_ENDPOINT}/quote?outputMint=${toMint.toBase58()}&inputMint=${fromMint.toBase58()}&amount=${amount}&slippage=0.5`
  ).then((response) => response.json());
};

const getSwapIx = async (user: PublicKey, quote: any) => {
  const data = {
    quoteResponse: quote,
    userPublicKey: user.toBase58(),
  };

  return fetch(`${API_ENDPOINT}/swap-instructions`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(data),
  }).then((response) => response.json());
};

const swapTokens = async (
  computeBudgetPayloads: any[],
  setupPayloads: any[],
  swapPayload: any,
  cleanupPayload: any | null,
  addressLookupTableAddresses: string[],
  feeAccount: PublicKey
) => {
  const instructions = [
    ...computeBudgetPayloads.map(instructionDataToTransactionInstruction),
    await program.methods
      .borrow(1000000, feeAccount)
      .accountsStrict({
        borrower: wallet.publicKey,
        programAuthority,
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram: SystemProgram.programId,
      })
      .instruction(),
    ...setupPayloads.map(instructionDataToTransactionInstruction),
    instructionDataToTransactionInstruction(swapPayload),
    instructionDataToTransactionInstruction(cleanupPayload), // can be null
    await program.methods
      .repay(1000000)
      .accountsStrict({
        borrower: wallet.publicKey,
        programAuthority,
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram: SystemProgram.programId,
      })
      .instruction(),
  ].filter((instruction) => {
    return instruction !== null;
  });

  const blockhash = (await connection.getLatestBlockhash()).blockhash;

  // If you want, you can add more lookup table accounts here
  const addressLookupTableAccounts = await getAdressLookupTableAccounts(
    addressLookupTableAddresses
  );
  const messageV0 = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message(addressLookupTableAccounts);
  const transaction = new VersionedTransaction(messageV0);

  try {
    await provider.simulate(transaction, [wallet.payer]);

    const txID = await provider.sendAndConfirm(transaction, [wallet.payer]);
    console.log({ txID });
  } catch (e) {
    console.log({ simulationResponse: e.simulationResponse });
  }
};

// Main
(async () => {
  const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  const feeAccount = new PublicKey(""); // Replace with your fee account public key

  // Find the best Quote from the Jupiter API
  const quote = await getQuote(USDC, NATIVE_MINT, 1000000);
  console.log({ quote });

  // Convert the Quote into a Swap instruction
  const result = await getSwapIx(wallet.publicKey, quote);

  if ("error" in result) {
    console.log({ result });
    return result;
  }

  // We have now both the instruction and the lookup table addresses.
  const {
    computeBudgetInstructions,
    setupInstructions,
    swapInstruction,
    cleanupInstruction,
    addressLookupTableAddresses,
  } = result;

  await swapTokens(
    computeBudgetInstructions,
    setupInstructions,
    swapInstruction,
    cleanupInstruction,
    addressLookupTableAddresses,
    feeAccount
  );
})();
