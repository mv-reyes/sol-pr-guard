impl Obligation {
    pub const LEN: usize = 1784;


    pub fn init(&mut self, params: InitObligationParams) {
        *self = Self::default();
        self.tag = params.tag;
        self.last_update = LastUpdate::new(params.current_slot);
        self.lending_market = params.lending_market;
        self.owner = params.owner;
        self.deposits = params.deposits;
        self.borrows = params.borrows;
        self.referrer = params.referrer;
    }


    pub fn loan_to_value(&self) -> Fraction {
        Fraction::from_bits(self.borrow_factor_adjusted_debt_value_sf)
            / Fraction::from_bits(self.deposited_value_sf)
    }

    pub fn no_bf_loan_to_value(&self) -> Fraction {
        Fraction::from_bits(self.borrowed_assets_market_value_sf)
            / Fraction::from_bits(self.deposited_value_sf)
    }


    pub fn unhealthy_loan_to_value(&self) -> Fraction {
        Fraction::from_bits(self.unhealthy_borrow_value_sf)
            / Fraction::from_bits(self.deposited_value_sf)
    }


    pub fn repay(&mut self, settle_amount: Fraction, liquidity_index: usize) {
        self.check_ownership_transfer_not_in_progress()?;
        let liquidity = &mut self.borrows[liquidity_index];
        if settle_amount == liquidity.borrowed_amount() {
            self.borrows[liquidity_index] = ObligationLiquidity::default();
        } else {
            liquidity.repay(settle_amount);
        }
    }




    pub fn withdraw(
        &mut self,
        withdraw_amount: u64,
        collateral_index: usize,
    ) -> Result<WithdrawResult> {
        self.check_ownership_transfer_not_in_progress()?;
        let collateral = &mut self.deposits[collateral_index];
        if withdraw_amount == collateral.deposited_amount {
            self.deposits[collateral_index] = ObligationCollateral::default();
            Ok(WithdrawResult::Full)
        } else {
            collateral.withdraw(withdraw_amount)?;
            Ok(WithdrawResult::Partial)
        }
    }


    pub fn max_withdraw_value(
        &self,
        obligation_collateral: &ObligationCollateral,
        reserve_max_ltv_pct: u8,
        reserve_liq_threshold_pct: u8,
        ltv_max_withdrawal_check: LtvMaxWithdrawalCheck,
    ) -> Fraction {
        let (highest_allowed_borrow_value, withdraw_collateral_ltv_pct) =
            if ltv_max_withdrawal_check == LtvMaxWithdrawalCheck::LiquidationThreshold {
                (
                    Fraction::from_bits(self.unhealthy_borrow_value_sf.saturating_sub(1)),
                    reserve_liq_threshold_pct,
                )
            } else {
                (
                    Fraction::from_bits(self.allowed_borrow_value_sf),
                    reserve_max_ltv_pct,
                )
            };

        let borrow_factor_adjusted_debt_value =
            Fraction::from_bits(self.borrow_factor_adjusted_debt_value_sf);

        if highest_allowed_borrow_value <= borrow_factor_adjusted_debt_value {
            return Fraction::ZERO;
        }

       
        if withdraw_collateral_ltv_pct == 0 {
            return Fraction::from_bits(obligation_collateral.market_value_sf);
        }

        highest_allowed_borrow_value.saturating_sub(borrow_factor_adjusted_debt_value) * 100_u128
            / u128::from(withdraw_collateral_ltv_pct)
    }


    pub fn remaining_borrow_value(&self) -> Fraction {
       
       
        Fraction::from_bits(
            self.allowed_borrow_value_sf
                .saturating_sub(self.borrow_factor_adjusted_debt_value_sf),
        )
    }


    pub fn find_collateral_in_deposits(
        &self,
        deposit_reserve: Pubkey,
    ) -> Result<&ObligationCollateral> {
        if self.is_active_deposits_empty() {
            xmsg!("Obligation has no deposits");
            return err!(LendingError::ObligationDepositsEmpty);
        }
        let collateral = self
            .deposits
            .iter()
            .find(|collateral| collateral.deposit_reserve == deposit_reserve)
            .ok_or(LendingError::InvalidObligationCollateral)?;
        Ok(collateral)
    }



    pub fn find_or_add_collateral_to_deposits(
        &mut self,
        deposit_reserve: Pubkey,
    ) -> Result<(&mut ObligationCollateral, bool)> {
        if let Some(collateral_index) = self
            .deposits
            .iter_mut()
            .position(|collateral| collateral.deposit_reserve == deposit_reserve)
        {
            Ok((&mut self.deposits[collateral_index], false))
        } else if let Some(collateral_index) = self.deposits.iter().position(|c| !c.is_active()) {
            let collateral = &mut self.deposits[collateral_index];
            *collateral = ObligationCollateral::new(deposit_reserve);
            Ok((collateral, true))
        } else {
            xmsg!("Obligation has no empty deposits");
            err!(LendingError::ObligationReserveLimit)
        }
    }

    pub fn position_of_collateral_in_deposits(&self, deposit_reserve: Pubkey) -> Result<usize> {
        if self.is_active_deposits_empty() {
            xmsg!("Obligation has no deposits");
            return err!(LendingError::ObligationDepositsEmpty);
        }
        self.deposits
            .iter()
            .position(|collateral| collateral.deposit_reserve == deposit_reserve)
            .ok_or(error!(LendingError::InvalidObligationCollateral))
    }


    pub fn find_liquidity_in_borrows(
        &self,
        borrow_reserve: Pubkey,
    ) -> Result<(&ObligationLiquidity, usize)> {
        if self.is_active_borrows_empty() {
            xmsg!("Obligation has no borrows");
            return err!(LendingError::ObligationBorrowsEmpty);
        }
        let liquidity_index = self
            .find_liquidity_index_in_borrows(borrow_reserve)
            .ok_or_else(|| error!(LendingError::InvalidObligationLiquidity))?;
        Ok((&self.borrows[liquidity_index], liquidity_index))
    }


    pub fn find_liquidity_in_borrows_mut(
        &mut self,
        borrow_reserve: Pubkey,
    ) -> Result<(&mut ObligationLiquidity, usize)> {
        if self.is_active_borrows_empty() {
            xmsg!("Obligation has no borrows");
            return err!(LendingError::ObligationBorrowsEmpty);
        }
        let liquidity_index = self
            .find_liquidity_index_in_borrows(borrow_reserve)
            .ok_or_else(|| error!(LendingError::InvalidObligationLiquidity))?;
        Ok((&mut self.borrows[liquidity_index], liquidity_index))
    }



    pub fn find_or_add_liquidity_to_borrows(
        &mut self,
        borrow_reserve: Pubkey,
        cumulative_borrow_rate: BigFraction,
    ) -> Result<(&mut ObligationLiquidity, usize)> {
        self.check_not_marked_for_deleveraging()?;
        self.check_ownership_transfer_not_in_progress()?;
        if let Some(liquidity_index) = self.find_liquidity_index_in_borrows(borrow_reserve) {
            Ok((&mut self.borrows[liquidity_index], liquidity_index))
        } else if let Some((index, liquidity)) = self
            .borrows
            .iter_mut()
            .enumerate()
            .find(|c| !c.1.is_active())
        {
            *liquidity = ObligationLiquidity::new(borrow_reserve, cumulative_borrow_rate);

            Ok((liquidity, index))
        } else {
            xmsg!("Obligation has no empty borrows");
            err!(LendingError::ObligationReserveLimit)
        }
    }

    pub fn find_liquidity_index_in_borrows(&self, borrow_reserve: Pubkey) -> Option<usize> {
        self.borrows
            .iter()
            .position(|liquidity| liquidity.borrow_reserve == borrow_reserve)
    }

    pub fn is_active_deposits_empty(&self) -> bool {
       
       
        self.deposits.iter().all(|deposit| !deposit.is_active())
    }

    pub fn is_active_borrows_empty(&self) -> bool {
       
       
        self.borrows.iter().all(|borrow| !borrow.is_active())
    }

    pub fn active_deposits_count(&self) -> usize {
        self.active_deposits().count()
    }

    pub fn active_borrows_count(&self) -> usize {
        self.active_borrows().count()
    }

    pub fn active_deposits(&self) -> impl Iterator<Item = &ObligationCollateral> {
        self.deposits.iter().filter(|c| c.is_active())
    }

    pub fn active_borrows(&self) -> impl Iterator<Item = &ObligationLiquidity> {
        self.borrows.iter().filter(|c| c.is_active())
    }

    pub fn active_deposits_mut(&mut self) -> impl Iterator<Item = &mut ObligationCollateral> {
        self.deposits.iter_mut().filter(|c| c.is_active())
    }

    pub fn active_borrows_mut(&mut self) -> impl Iterator<Item = &mut ObligationLiquidity> {
        self.borrows.iter_mut().filter(|c| c.is_active())
    }


    pub fn get_active_borrow_mut(&mut self, index: usize) -> Result<&mut ObligationLiquidity> {
        let Some(borrow) = self.borrows.get_mut(index) else {
            xmsg!("Invalid obligation borrow index: {}", index);
            return err!(LendingError::InvalidObligationLiquidity);
        };
        if !borrow.is_active() {
            xmsg!("Obligation borrow slot {} not active", index);
            return err!(LendingError::InvalidObligationLiquidity);
        }
        Ok(borrow)
    }








    pub fn get_borrowed_amount_if_single_token(&self) -> Option<u64> {
        if self.active_borrows_count() > 1 {
            None
        } else {
            Some(
                Fraction::from_bits(self.borrows.iter().map(|l| l.borrowed_amount_sf).sum())
                    .to_ceil::<u64>(),
            )
        }
    }

    pub fn get_bf_adjusted_debt_value(&self) -> Fraction {
        Fraction::from_bits(self.borrow_factor_adjusted_debt_value_sf)
    }

    pub fn get_allowed_borrow_value(&self) -> Fraction {
        Fraction::from_bits(self.allowed_borrow_value_sf)
    }

    pub fn get_unhealthy_borrow_value(&self) -> Fraction {
        Fraction::from_bits(self.unhealthy_borrow_value_sf)
    }


    pub fn get_borrowed_assets_market_value(&self) -> Fraction {
        Fraction::from_bits(self.borrowed_assets_market_value_sf)
    }

    pub fn has_referrer(&self) -> bool {
        self.referrer != Pubkey::default()
    }

    pub fn update_has_debt(&mut self) {
        self.has_debt = u8::from(!self.is_active_borrows_empty());
    }





    pub fn has_debt(&self) -> bool {
        self.has_debt == true as u8
    }

    pub fn is_marked_for_deleveraging(&self) -> bool {
        self.autodeleverage_margin_call_started_timestamp != 0
    }

    pub fn mark_for_deleveraging(&mut self, current_timestamp: u64, target_ltv_pct: u8) {
        if current_timestamp == 0 {
            panic!("value reserved for non-marked state");
        }
        self.autodeleverage_margin_call_started_timestamp = current_timestamp;
        self.autodeleverage_target_ltv_pct = target_ltv_pct;
    }

    pub fn unmark_for_deleveraging(&mut self) {
        self.autodeleverage_margin_call_started_timestamp = 0;
        self.autodeleverage_target_ltv_pct = 0;
    }

    pub fn check_not_marked_for_deleveraging(&self) -> Result<()> {
        if self.is_marked_for_deleveraging() {
            xmsg!(
                "Obligation marked for deleveraging since {}",
                self.autodeleverage_margin_call_started_timestamp
            );
            return err!(LendingError::ObligationCurrentlyMarkedForDeleveraging);
        }
        Ok(())
    }

    pub fn has_obsolete_reserves(&self) -> bool {
        self.num_of_obsolete_borrow_reserves > 0 || self.num_of_obsolete_deposit_reserves > 0
    }






    pub fn single_debt(&self) -> Option<&ObligationLiquidity> {
        self.active_borrows().only_element()
    }






    pub fn single_collateral(&self) -> Option<&ObligationCollateral> {
        self.active_deposits().only_element()
    }






    pub fn is_single_debt_single_coll(&self) -> bool {
        self.active_deposits_count() == 1 && self.active_borrows_count() == 1
    }


    pub fn ownership_transfer_state(&self) -> OwnershipTransferState {
        OwnershipTransferState::try_from(self.ownership_transfer_state)
            .expect("Invalid serialized ownership transfer state")
    }


    pub fn is_ownership_transfer_in_progress(&self) -> bool {
        self.ownership_transfer_state() != OwnershipTransferState::None
    }

    pub fn check_ownership_transfer_not_in_progress(&self) -> Result<()> {
        if self.is_ownership_transfer_in_progress() {
            xmsg!("Obligation ownership transfer in progress");
            return err!(LendingError::ObligationOwnershipTransferInProgress);
        }
        Ok(())
    }

    pub fn check_ownership_transfer_in_progress(&self) -> Result<()> {
        if !self.is_ownership_transfer_in_progress() {
            xmsg!("Obligation ownership transfer not initiated");
            return err!(LendingError::ObligationOwnershipTransferNotInitiated);
        }
        Ok(())
    }


    pub fn is_ownership_transfer_initiated(&self) -> bool {
        self.ownership_transfer_state() == OwnershipTransferState::Initiated
    }


    pub fn is_ownership_transfer_approved(&self) -> bool {
        self.ownership_transfer_state() == OwnershipTransferState::Approved
    }

    pub fn check_ownership_transfer_initiated(&self) -> Result<()> {
        if !self.is_ownership_transfer_initiated() {
            xmsg!("Obligation ownership transfer not initiated");
            return err!(LendingError::ObligationOwnershipTransferNotInitiated);
        }
        Ok(())
    }

    pub fn check_ownership_transfer_approved(&self) -> Result<()> {
        if !self.is_ownership_transfer_approved() {
            xmsg!("Obligation ownership transfer not approved");
            return err!(LendingError::ObligationOwnershipTransferNotApproved);
        }
        Ok(())
    }




    pub fn initiate_ownership_transfer(&mut self, pending_owner: Pubkey) -> Result<()> {
        self.check_ownership_transfer_not_in_progress()?;
       
        if pending_owner == Pubkey::default() {
            xmsg!("Pending owner cannot be the default pubkey");
            return err!(LendingError::ObligationInvalidPendingOwner);
        }

       
        if pending_owner == self.owner {
            xmsg!("Pending owner cannot be the current owner");
            return err!(LendingError::ObligationInvalidPendingOwner);
        }

        self.ownership_transfer_state = OwnershipTransferState::Initiated.into();
        self.pending_owner = pending_owner;
        Ok(())
    }





    pub fn approve_ownership_transfer(&mut self) -> Result<()> {
        self.check_ownership_transfer_initiated()?;
        self.ownership_transfer_state = OwnershipTransferState::Approved.into();
        Ok(())
    }




    pub fn accept_ownership(&mut self) -> Result<()> {
        self.check_ownership_transfer_approved()?;
        self.owner = self.pending_owner;
        self.pending_owner = Pubkey::default();
        self.ownership_transfer_state = OwnershipTransferState::None.into();
        Ok(())
    }




    pub fn abort_ownership_transfer(&mut self) -> Result<()> {
        self.check_ownership_transfer_in_progress()?;
        self.pending_owner = Pubkey::default();
        self.ownership_transfer_state = OwnershipTransferState::None.into();
        Ok(())
    }
}
