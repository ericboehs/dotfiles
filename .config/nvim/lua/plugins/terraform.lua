return {
  {
    "neovim/nvim-lspconfig",
    opts = {
      servers = {
        terraformls = {
          -- Without a .terraform dir, terraform-ls falls back to the .git root
          -- and recursively indexes the whole monorepo (ansible, loadtest,
          -- packer, 380+ .tf files). A terraform module is a single directory,
          -- so root each buffer at its own dir. Cross-module go-to-definition
          -- still follows module sources relative to the file.
          root_dir = function(bufnr, on_dir)
            on_dir(vim.fs.dirname(vim.api.nvim_buf_get_name(bufnr)))
          end,
        },
      },
    },
  },
  -- terraform-ls's semantic tokens response sends Neovim's position-encoding
  -- handler (vim.str_utfindex) into an infinite loop on some files (e.g. ones
  -- with JSON heredocs), hard-freezing the editor a few seconds after open.
  -- Diagnostics, hover, completion, and go-to-definition are unaffected, so
  -- drop only the semantic tokens capability for this server.
  {
    "neovim/nvim-lspconfig",
    init = function()
      vim.api.nvim_create_autocmd("LspAttach", {
        callback = function(args)
          local client = vim.lsp.get_client_by_id(args.data.client_id)
          if client and client.name == "terraformls" then
            client.server_capabilities.semanticTokensProvider = nil
          end
        end,
      })
    end,
  },
}
