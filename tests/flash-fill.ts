import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { FlashFill } from "../target/types/flash_fill";
import {
  Keypair,
  SystemProgram,
  Transaction,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  NATIVE_MINT,
} from "@solana/spl-token";
import { expect } from "chai";

const WALLET_RENT_EXEMPT_MINIMUM = 890_880;
const LAMPORTS_PER_SIGNATURE = 5000;
const TOKEN_ACCOUNT_LAMPORTS = 2_039_280;

describe("flash-fill", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const provider = anchor.getProvider();
  const program = anchor.workspace.FlashSwap as Program<FlashFill>;
  const borrower = new Keypair();
  const connection = provider.connection;
  const feeAccount = new PublicKey("YourFeeAccountPublicKeyHere"); // Replace with your fee account public key
  const programAuthority = PublicKey.findProgramAddressSync(
    [Buffer.from("authority")],
    program.programId
  )[0];

  it("is working", async () => {
    const transferToProgramAuthorityInstruction = SystemProgram.transfer({
      fromPubkey: provider.publicKey,
      toPubkey: programAuthority,
      lamports: TOKEN_ACCOUNT_LAMPORTS + WALLET_RENT_EXEMPT_MINIMUM,
    });

    const transferToBorrowerInstruction = SystemProgram.transfer({
      fromPubkey: provider.publicKey,
      toPubkey: borrower.publicKey,
      lamports: LAMPORTS_PER_SIGNATURE * 4 + WALLET_RENT_EXEMPT_MINIMUM,
    });

    await provider.sendAndConfirm(
      new Transaction().add(
        transferToProgramAuthorityInstruction,
        transferToBorrowerInstruction
      )
    );

    const borrowIx = await program.methods
      .borrow(1000000, feeAccount)
      .accountsStrict({
        borrower: borrower.publicKey,
        programAuthority,
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const tokenAccountAddress = await getAssociatedTokenAddress(
      NATIVE_MINT,
      borrower.publicKey
    );

    const createTokenAccountIx =
      createAssociatedTokenAccountIdempotentInstruction(
        borrower.publicKey,
        tokenAccountAddress,
        borrower.publicKey,
        NATIVE_MINT
      );

    const closeTokenAccountIx = createCloseAccountInstruction(
      tokenAccountAddress,
      borrower.publicKey,
      borrower.publicKey
    );

    const repayIx = await program.methods
      .repay(1000000)
      .accountsStrict({
        borrower: borrower.publicKey,
        programAuthority,
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const tx = new Transaction().add(
      borrowIx,
      createTokenAccountIx,
      closeTokenAccountIx,
      repayIx
    );

    let success1 = true;
    try {
      await sendAndConfirmTransaction(connection, tx, [borrower]);
    } catch (e) {
      console.log(e);
      success1 = false;
    }
    expect(success1).to.be.true;

    const failedTx1 = new Transaction().add(
      borrowIx,
      createTokenAccountIx,
      closeTokenAccountIx
    );

    let success2 = true;
    try {
      await sendAndConfirmTransaction(connection, failedTx1, [borrower]);
    } catch (e) {
      console.log(e);
      success2 = false;
    }
    expect(success2).to.be.false;

    const failedTx2 = new Transaction().add(
      borrowIx,
      borrowIx,
      createTokenAccountIx,
      closeTokenAccountIx,
      repayIx
    );

    let success3 = true;
    try {
      await sendAndConfirmTransaction(connection, failedTx2, [borrower]);
    } catch (e) {
      console.log(e);
      success3 = false;
    }
    expect(success3).to.be.false;
  });
});
