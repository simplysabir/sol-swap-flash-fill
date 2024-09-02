use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar;
use anchor_lang::solana_program::sysvar::instructions::{
    load_current_index_checked, load_instruction_at_checked,
};
use anchor_lang::Discriminator;
use anchor_spl::token::{TokenAccount, Token, Transfer, Mint};

use anchor_lang::system_program;

pub const AUTHORITY_SEED: &[u8] = b"authority";

declare_id!("JUPLdTqUdKztWJ1isGMV92W2QvmEmzs9WTJjhZe4QdJ");

#[program]
pub mod flash_fill {
    use super::*;

    pub fn borrow(ctx: Context<Borrow>, input_amount: u64, fee_account: Pubkey) -> Result<()> {
        let ixs = ctx.accounts.instructions.to_account_info();

        // Ensure this is not a CPI call
        let current_index = load_current_index_checked(&ixs)? as usize;
        let current_ix = load_instruction_at_checked(current_index, &ixs)?;
        if current_ix.program_id != *ctx.program_id {
            return Err(FlashFillError::ProgramMismatch.into());
        }

        // Find corresponding repay instruction
        let mut index = current_index + 1;
        loop {
            if let Ok(ix) = load_instruction_at_checked(index, &ixs) {
                if ix.program_id == crate::id() {
                    let ix_discriminator: [u8; 8] = ix.data[0..8]
                        .try_into()
                        .map_err(|_| FlashFillError::UnknownInstruction)?;

                    if ix_discriminator == self::instruction::Repay::discriminator() {
                        require_keys_eq!(
                            ix.accounts[1].pubkey,
                            ctx.accounts.program_authority.key(),
                            FlashFillError::IncorrectProgramAuthority
                        );
                        break;
                    } else if ix_discriminator == self::instruction::Borrow::discriminator() {
                        return Err(FlashFillError::CannotBorrowBeforeRepay.into());
                    } else {
                        return Err(FlashFillError::UnknownInstruction.into());
                    }
                }
            } else {
                return Err(FlashFillError::MissingRepay.into());
            }

            index += 1
        }

        let authority_bump = ctx.bumps.get("program_authority").unwrap().to_le_bytes();
        let rent = Rent::get()?;
        let space = TokenAccount::LEN;
        let token_lamports = rent.minimum_balance(space);

        // Calculate fee and net amount
        let fee_amount = input_amount.checked_mul(1).unwrap().checked_div(100).unwrap();
        let net_amount = input_amount.checked_sub(fee_amount).unwrap();

        // Transfer fee to fee account
        let signer_seeds: &[&[&[u8]]] = &[&[AUTHORITY_SEED, authority_bump.as_ref()]];
        system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.program_authority.to_account_info(),
                    to: ctx.accounts.fee_account.to_account_info(),
                },
                signer_seeds,
            ),
            fee_amount,
        )?;

        // Transfer net amount to borrower
        system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.program_authority.to_account_info(),
                    to: ctx.accounts.borrower.to_account_info(),
                },
                signer_seeds,
            ),
            net_amount,
        )?;

        Ok(())
    }

    pub fn repay(ctx: Context<Repay>, input_amount: u64) -> Result<()> {
        let ixs = ctx.accounts.instructions.to_account_info();

        // Ensure this is not a CPI call
        let current_index = load_current_index_checked(&ixs)? as usize;
        let current_ix = load_instruction_at_checked(current_index, &ixs)?;
        if current_ix.program_id != *ctx.program_id {
            return Err(FlashFillError::ProgramMismatch.into());
        }

        let authority_bump = ctx.bumps.get("program_authority").unwrap().to_le_bytes();
        let signer_seeds: &[&[&[u8]]] = &[&[AUTHORITY_SEED, authority_bump.as_ref()]];

        // Transfer repaid amount back to program authority
        system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.borrower.to_account_info(),
                    to: ctx.accounts.program_authority.to_account_info(),
                },
                signer_seeds,
            ),
            input_amount,
        )?;

        Ok(())
    }
}

#[derive(Accounts)]
pub struct Borrow<'info> {
    pub borrower: Signer<'info>,
    #[account(mut, seeds = [AUTHORITY_SEED], bump)]
    pub program_authority: SystemAccount<'info>,
    /// CHECK: Fee account to transfer fees
    #[account(mut)]
    pub fee_account: UncheckedAccount<'info>,
    /// CHECK: Instructions account
    #[account(address = sysvar::instructions::ID @FlashFillError::AddressMismatch)]
    pub instructions: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Repay<'info> {
    pub borrower: Signer<'info>,
    #[account(mut, seeds = [AUTHORITY_SEED], bump)]
    pub program_authority: SystemAccount<'info>,
    /// CHECK: Instructions account
    #[account(address = sysvar::instructions::ID @FlashFillError::AddressMismatch)]
    pub instructions: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// Errors for this program
#[error_code]
pub enum FlashFillError {
    #[msg("Address Mismatch")]
    AddressMismatch,
    #[msg("Program Mismatch")]
    ProgramMismatch,
    #[msg("Missing Repay")]
    MissingRepay,
    #[msg("Incorrect Program Authority")]
    IncorrectProgramAuthority,
    #[msg("Cannot Borrow Before Repay")]
    CannotBorrowBeforeRepay,
    #[msg("Unknown Instruction")]
    UnknownInstruction,
}
